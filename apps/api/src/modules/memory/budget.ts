import { randomUUID } from 'node:crypto';
import type { MemoryRuntimePolicy } from '@fateclaw/contracts/memory';
import type pg from 'pg';
import { getDbPool } from '#infrastructure/db-pool';
import { MemoryError } from './domain.js';
import { withMemoryTransaction } from './repository.js';

export interface MemoryBudgetReservation {
  id: string;
  day: string;
  purpose: string;
  ownerUserId: string;
  tokens: number;
  jobId?: string;
}

interface StoredMemoryBudgetReservation {
  id: string;
  job_id: string | null;
  owner_user_id: string;
  day: string;
  purpose: string;
  reserved_tokens: string | number;
}

interface MemoryBudgetSettlement {
  purpose: string;
  modelConfigId: string;
  model: string;
  usage?: { inputTokens: number; outputTokens: number; estimated?: boolean };
  durationMs: number;
}

const RESERVATION_RECOVERY_GRACE_MS = 5_000;
const BUDGET_PURPOSE = 'language';

const budgetDay = () => new Date().toISOString().slice(0, 10);

function budgetExhausted(): MemoryError {
  return new MemoryError(
    '今日记忆处理预算已用完，任务将稍后继续',
    429,
    'MEMORY.BUDGET_EXHAUSTED',
  );
}

export async function assertMemoryBudgetOpen(
  policy: MemoryRuntimePolicy,
): Promise<void> {
  const { rows } = await getDbPool().query(
    'SELECT 1 FROM memory_daily_budgets WHERE day=$1 AND purpose=$2 AND used_tokens+reserved_tokens>=$3',
    [budgetDay(), BUDGET_PURPOSE, policy.daily_token_budget],
  );
  if (rows[0]) throw budgetExhausted();
}

export async function reserveMemoryBudget(args: {
  ownerUserId: string;
  purpose: string;
  tokens: number;
  policy: MemoryRuntimePolicy;
  jobId?: string;
  jobLeaseToken?: string;
}): Promise<MemoryBudgetReservation> {
  const day = budgetDay();
  const purpose = BUDGET_PURPOSE;
  const limit = args.policy.daily_token_budget;
  const timeoutMs = args.policy.job_timeout_ms;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 2_147_483_647
  )
    throw new MemoryError(
      '记忆预算调用期限配置无效。',
      400,
      'MEMORY.INVALID_POLICY',
    );
  return withMemoryTransaction(async (db) => {
    if (args.jobId) {
      const job = await db.query(
        "SELECT 1 FROM memory_jobs WHERE id=$1 AND owner_user_id=$2 AND state='running' AND lease_token=$3 AND lease_until>clock_timestamp() FOR UPDATE",
        [args.jobId, args.ownerUserId, args.jobLeaseToken],
      );
      if (!job.rows[0])
        throw new MemoryError(
          '记忆任务租约已失效',
          409,
          'MEMORY.LEASE_EXPIRED',
        );
    }
    await db.query(
      'INSERT INTO memory_daily_budgets(day,purpose) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [day, purpose],
    );
    const { rows } = await db.query(
      `UPDATE memory_daily_budgets SET reserved_tokens=reserved_tokens+$3,calls=calls+1
       WHERE day=$1 AND purpose=$2 AND used_tokens+reserved_tokens+$3<=$4 RETURNING day`,
      [day, purpose, args.tokens, limit],
    );
    if (!rows[0]) throw budgetExhausted();
    const reservation = {
      id: randomUUID(),
      day,
      purpose,
      ownerUserId: args.ownerUserId,
      tokens: args.tokens,
      jobId: args.jobId,
    };
    await db.query(
      `INSERT INTO memory_budget_reservations(id,job_id,owner_user_id,lease_token,day,purpose,reserved_tokens,deadline_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+$8::int*interval '1 millisecond')`,
      [
        reservation.id,
        args.jobId ?? null,
        args.ownerUserId,
        args.jobLeaseToken ?? null,
        day,
        purpose,
        args.tokens,
        timeoutMs,
      ],
    );
    return reservation;
  });
}

async function settleStoredMemoryBudget(
  db: pg.PoolClient,
  reservation: StoredMemoryBudgetReservation,
  result: MemoryBudgetSettlement,
): Promise<boolean> {
  const tokens = Number(reservation.reserved_tokens);
  const inserted = await db.query(
    `INSERT INTO memory_usage(id,job_id,owner_user_id,purpose,model_config_id,model,input_tokens,output_tokens,usage_known,duration_ms)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING RETURNING id`,
    [
      reservation.id,
      reservation.job_id,
      reservation.owner_user_id,
      result.purpose,
      result.modelConfigId,
      result.model,
      result.usage?.inputTokens ?? tokens,
      result.usage?.outputTokens ?? 0,
      Boolean(result.usage && !result.usage.estimated),
      result.durationMs,
    ],
  );
  if (!inserted.rows[0]) return false;
  const used = result.usage
    ? result.usage.inputTokens + result.usage.outputTokens
    : tokens;
  await db.query(
    'UPDATE memory_daily_budgets SET reserved_tokens=GREATEST(0,reserved_tokens-$3),used_tokens=used_tokens+$4 WHERE day=$1 AND purpose=$2',
    [reservation.day, reservation.purpose, tokens, used],
  );
  await db.query(
    "UPDATE memory_budget_reservations SET state='settled',settled_at=clock_timestamp() WHERE id=$1",
    [reservation.id],
  );
  return true;
}

export async function settleMemoryBudget(
  reservation: MemoryBudgetReservation,
  result: MemoryBudgetSettlement,
): Promise<void> {
  await withMemoryTransaction(async (db) => {
    const locked = await db.query<StoredMemoryBudgetReservation>(
      "SELECT id,job_id,owner_user_id,day::text,purpose,reserved_tokens FROM memory_budget_reservations WHERE id=$1 AND state='pending' FOR UPDATE",
      [reservation.id],
    );
    if (!locked.rows[0]) return;
    await settleStoredMemoryBudget(db, locked.rows[0], result);
  });
}

export async function reconcileMemoryBudgetReservations(
  _policy: MemoryRuntimePolicy,
  options: { signal?: AbortSignal; limit?: number } = {},
): Promise<number> {
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new MemoryError(
      '记忆预算恢复批量大小无效。',
      400,
      'MEMORY.INVALID_POLICY',
    );
  options.signal?.throwIfAborted();
  return withMemoryTransaction(async (db) => {
    const { rows } = await db.query<StoredMemoryBudgetReservation>(
      `SELECT r.id,r.job_id,r.owner_user_id,r.day::text,r.purpose,r.reserved_tokens
       FROM memory_budget_reservations r LEFT JOIN memory_jobs j ON j.id=r.job_id
       WHERE r.state='pending' AND r.deadline_at<=statement_timestamp()-$1::int*interval '1 millisecond'
         AND (r.job_id IS NULL OR j.id IS NULL OR j.state<>'running' OR j.lease_token IS DISTINCT FROM r.lease_token
           OR j.lease_until IS NULL OR j.lease_until<=clock_timestamp())
       ORDER BY r.deadline_at,r.id FOR UPDATE OF r SKIP LOCKED LIMIT $2`,
      [RESERVATION_RECOVERY_GRACE_MS, limit],
    );
    let recovered = 0;
    for (const row of rows) {
      options.signal?.throwIfAborted();
      if (
        await settleStoredMemoryBudget(db, row, {
          purpose: `memory.${row.purpose}.recovered`,
          modelConfigId: 'unknown',
          model: 'unknown',
          durationMs: 0,
        })
      )
        recovered++;
    }
    options.signal?.throwIfAborted();
    return recovered;
  });
}
