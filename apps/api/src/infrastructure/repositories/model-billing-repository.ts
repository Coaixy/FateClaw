import {
  toCoins,
  normalizeUserCoins,
  deductModelChargeCoinsAllowDebt,
  insertWalletTransaction,
} from './wallet-repository.js';
import type { User } from '#shared/types';
import type pg from 'pg';
import { getDbPool } from '#infrastructure/db-pool';
import { logger } from '#infrastructure/logger';
import { getUserByIdUsing } from './users-repository.js';
import { roundCoinsToCents } from '#shared/balance-coins';
import { MAX_OVERDRAFT_COINS } from '#infrastructure/config';

function numberFromMetadata(
  metadata: unknown,
  key: string,
): number | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const value = (metadata as Record<string, unknown>)[key];
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function normalizeBillingRequestReservationRow(
  row: BillingRequestReservationRow,
): BillingRequestReservationRow {
  return {
    ...row,
    reserved_coins: toCoins(row.reserved_coins),
    actual_charge_coins: toCoins(row.actual_charge_coins),
    total_overage_cost_coins: toCoins(row.total_overage_cost_coins),
  };
}

function normalizeMonthlyBillingStateRow(
  row: MonthlyBillingStateRow,
): MonthlyBillingStateRow {
  return {
    ...row,
    billed_overage_cost_coins: toCoins(row.billed_overage_cost_coins),
  };
}

export interface MonthlyBillingStateRow {
  user_id: string;
  year_month: string;
  billed_overage_tokens: number;
  billed_overage_cost_coins: number;
  updated_at: string;
}

export interface BillingRequestReservationRow {
  request_id: string;
  user_id: string;
  model_config_id: string | null;
  year_month: string;
  reserved_coins: number;
  hold_state: 'none' | 'held' | 'released';
  charge_state: 'pending' | 'charged';
  actual_charge_coins: number;
  total_overage_tokens: number;
  total_overage_cost_coins: number;
  note: string | null;
  metadata: unknown;
  released_at: string | null;
  charged_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 管理后台请求级计费预约分页响应。 */
export interface BillingRequestReservationListResult {
  reservations: BillingRequestReservationRow[];
  total: number;
}

/**
 * 单次模型请求结算结果。
 *
 * @remarks Model usage is charged in full; membership does not include free credits.
 *   actualChargeCoins 即按真实 Token 费用实扣（BYOK 在 plans 层提前短路为 0）。
 */
export interface ModelChargeSettlementResult {
  actualChargeCoins: number;
  rawChargeCoins: number;
  user: User;
}

async function insertBillingRequestReservation(
  client: pg.PoolClient,
  input: {
    requestId: string;
    userId: string;
    modelConfigId?: string | null;
    yearMonth: string;
    reservedCoins: number;
    holdState: BillingRequestReservationRow['hold_state'];
    note?: string | null;
    metadata?: unknown;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO billing_request_reservations
      (request_id, user_id, model_config_id, year_month, reserved_coins,
       hold_state, charge_state, note, metadata, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, NOW(), NOW())
     ON CONFLICT (request_id) DO NOTHING`,
    [
      input.requestId,
      input.userId,
      input.modelConfigId ?? null,
      input.yearMonth,
      input.reservedCoins,
      input.holdState,
      input.note ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ],
  );
}

export async function getBillingRequestReservationByRequestId(
  requestId: string,
): Promise<BillingRequestReservationRow | undefined> {
  const { rows } = await getDbPool().query(
    'SELECT * FROM billing_request_reservations WHERE request_id = $1',
    [requestId],
  );
  const row = rows[0] as BillingRequestReservationRow | undefined;
  return row ? normalizeBillingRequestReservationRow(row) : undefined;
}

export async function listBillingRequestReservations(opts?: {
  userId?: string;
  holdState?: BillingRequestReservationRow['hold_state'];
  chargeState?: BillingRequestReservationRow['charge_state'];
  limit?: number;
  offset?: number;
}): Promise<BillingRequestReservationRow[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (opts?.userId) {
    where.push(`user_id = $${idx++}`);
    values.push(opts.userId);
  }
  if (opts?.holdState) {
    where.push(`hold_state = $${idx++}`);
    values.push(opts.holdState);
  }
  if (opts?.chargeState) {
    where.push(`charge_state = $${idx++}`);
    values.push(opts.chargeState);
  }
  values.push(Math.min(opts?.limit ?? 50, 200));
  values.push(Math.max(opts?.offset ?? 0, 0));
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await getDbPool().query(
    `SELECT * FROM billing_request_reservations
     ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    values,
  );
  return (rows as BillingRequestReservationRow[]).map(
    normalizeBillingRequestReservationRow,
  );
}

/**
 * 查询管理后台使用的请求级计费预约分页列表。
 *
 * @param opts - 可按用户、冻结状态和结算状态筛选，并支持分页。
 * @returns 计费预约列表与匹配总数。
 */
export async function listBillingRequestReservationsPageForAdmin(
  opts: {
    userId?: string;
    holdState?: BillingRequestReservationRow['hold_state'];
    chargeState?: BillingRequestReservationRow['charge_state'];
    limit?: number;
    offset?: number;
  } = {},
): Promise<BillingRequestReservationListResult> {
  const where: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (opts.userId) {
    where.push(`user_id = $${idx++}`);
    values.push(opts.userId);
  }
  if (opts.holdState) {
    where.push(`hold_state = $${idx++}`);
    values.push(opts.holdState);
  }
  if (opts.chargeState) {
    where.push(`charge_state = $${idx++}`);
    values.push(opts.chargeState);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  const { rows: countRows } = await getDbPool().query(
    `SELECT COUNT(*) AS cnt
     FROM billing_request_reservations
     ${whereClause}`,
    values,
  );

  const { rows } = await getDbPool().query(
    `SELECT *
     FROM billing_request_reservations
     ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${idx++} OFFSET $${idx++}`,
    [...values, limit, offset],
  );

  return {
    reservations: (rows as BillingRequestReservationRow[]).map(
      normalizeBillingRequestReservationRow,
    ),
    total: Number((countRows[0] as { cnt: string }).cnt),
  };
}

export async function reconcileStaleBillingReservations(
  staleBeforeIso: string,
  limit = 100,
): Promise<{ released: number; requestIds: string[] }> {
  const { rows } = await getDbPool().query(
    `SELECT *
     FROM billing_request_reservations
     WHERE hold_state = 'held'
       AND charge_state = 'pending'
       AND updated_at < $1
     ORDER BY updated_at ASC
     LIMIT $2`,
    [staleBeforeIso, Math.min(Math.max(limit, 1), 200)],
  );
  let released = 0;
  const requestIds: string[] = [];

  for (const row of (rows as BillingRequestReservationRow[]).map(
    normalizeBillingRequestReservationRow,
  )) {
    try {
      await releaseUserBalanceReservation(row.request_id, '陈旧预留自动释放', {
        source: 'reconcile',
      });
      released++;
      requestIds.push(row.request_id);
    } catch (err) {
      logger.warn({ requestId: row.request_id, err }, '自动释放陈旧预留失败');
    }
  }

  return { released, requestIds };
}

/**
 * 列出陈旧的未结算预留，供 billing-sweeper 兜底结算。
 *
 * @param staleBeforeIso 仅返回创建早于此时刻的预留，避免误碰仍在途的请求。
 * @param limit 单批上限（1-500）。
 * @returns charge_state='pending' 且创建超期的预留，按创建时间升序（最旧先处理）。
 * @remarks 与 reconcileStaleBillingReservations 不同：这里不限 hold_state（新预留恒为 'none'），
 *          按 charge_state 维度兜底真正未结算的请求，而非只释放历史冻结。
 */
export async function listStalePendingReservations(
  staleBeforeIso: string,
  limit = 100,
): Promise<BillingRequestReservationRow[]> {
  const { rows } = await getDbPool().query(
    `SELECT *
     FROM billing_request_reservations r
     WHERE charge_state = 'pending'
       AND created_at < $1
       AND (NOT EXISTS (SELECT 1 FROM agent_requests a WHERE a.request_id=r.request_id)
         OR EXISTS (SELECT 1 FROM conversation_logs l WHERE l.request_id=r.request_id)
         OR EXISTS (
           SELECT 1 FROM agent_requests a WHERE a.request_id=r.request_id
             AND a.state IN ('result_ready','completed')
             AND (a.result #> '{metadata,synthetic_terminal}') IS DISTINCT FROM 'true'::jsonb
             AND (jsonb_typeof(a.result #> '{usage,promptTokens}') = 'number'
               OR jsonb_typeof(a.result #> '{usage,completionTokens}') = 'number'
               OR jsonb_typeof(a.result #> '{usage,totalTokens}') = 'number')
         ))
     ORDER BY created_at ASC
     LIMIT $2`,
    [staleBeforeIso, Math.min(Math.max(limit, 1), 500)],
  );
  return (rows as BillingRequestReservationRow[]).map(
    normalizeBillingRequestReservationRow,
  );
}

async function getModelChargeSettlementMetadataUsing(
  client: pg.PoolClient,
  requestId: string,
): Promise<{
  rawChargeCoins?: number;
}> {
  // 单层化后不再有会员额度抵扣流水（membership_allowance_use 已停写），
  // 幂等重结算只需从 overage_charge 流水回看原始 Token 费用。
  const { rows } = await client.query(
    `SELECT metadata
     FROM wallet_transactions
     WHERE request_id = $1
       AND kind = 'overage_charge'
     ORDER BY created_at ASC
     LIMIT 1`,
    [requestId],
  );
  const metadata = (rows[0] as { metadata?: unknown } | undefined)?.metadata;
  return {
    rawChargeCoins: numberFromMetadata(metadata, 'rawRequestCostCoins'),
  };
}

/**
 * 登记一次模型请求的待结算记录。
 *
 * 现在请求开始不再冻结余额；该记录只负责给响应结算提供幂等键和归属月份。
 */
export async function reserveUserBalanceCoins(input: {
  userId: string;
  amountCoins: number;
  requestId: string;
  yearMonth: string;
  modelConfigId?: string | null;
  note?: string | null;
  metadata?: unknown;
}): Promise<{ user: User; reservedCoins: number }> {
  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    const { rows: existingRows } = await client.query(
      'SELECT * FROM billing_request_reservations WHERE request_id = $1 FOR UPDATE',
      [input.requestId],
    );
    const existing = existingRows[0]
      ? normalizeBillingRequestReservationRow(
          existingRows[0] as BillingRequestReservationRow,
        )
      : undefined;
    if (existing) {
      const existingUser = await getUserByIdUsing(client, existing.user_id);
      if (!existingUser) {
        throw new Error('用户不存在');
      }
      await client.query('COMMIT');
      return {
        user: normalizeUserCoins(existingUser),
        reservedCoins: existing.reserved_coins,
      };
    }

    const user = await getUserByIdUsing(client, input.userId);
    if (!user) {
      throw new Error('用户不存在');
    }

    await insertBillingRequestReservation(client, {
      requestId: input.requestId,
      userId: input.userId,
      modelConfigId: input.modelConfigId ?? null,
      yearMonth: input.yearMonth,
      reservedCoins: 0,
      holdState: 'none',
      note: input.note ?? null,
      metadata: input.metadata,
    });

    await client.query('COMMIT');
    return {
      user: normalizeUserCoins(user),
      reservedCoins: 0,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function releaseUserBalanceReservation(
  requestId: string,
  note?: string | null,
  metadata?: unknown,
): Promise<User> {
  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    const { rows: reservationRows } = await client.query(
      `SELECT * FROM billing_request_reservations
       WHERE request_id = $1
       FOR UPDATE`,
      [requestId],
    );
    const reservation = reservationRows[0]
      ? normalizeBillingRequestReservationRow(
          reservationRows[0] as BillingRequestReservationRow,
        )
      : undefined;
    if (!reservation) {
      throw new Error('预留记录不存在');
    }
    const user = await getUserByIdUsing(client, reservation.user_id, {
      forUpdate: true,
    });
    if (!user) {
      throw new Error('用户不存在');
    }

    const releasable =
      reservation.hold_state === 'held' ? reservation.reserved_coins : 0;
    const nextReservedCoins = Math.max(0, user.reserved_coins - releasable);
    const { rows: updatedRows } = await client.query(
      `UPDATE users
       SET reserved_coins = $1
       WHERE id = $2
       RETURNING *`,
      [nextReservedCoins, reservation.user_id],
    );

    await client.query(
      `UPDATE billing_request_reservations
       SET hold_state = CASE WHEN hold_state = 'held' THEN 'released' ELSE hold_state END,
           released_at = CASE WHEN hold_state = 'held' THEN NOW() ELSE released_at END,
           note = COALESCE($2, note),
           metadata = COALESCE($3, metadata),
           updated_at = NOW()
       WHERE request_id = $1`,
      [requestId, note ?? null, metadata ? JSON.stringify(metadata) : null],
    );

    // 不再插入释放流水记录，只有实际扣费才记录到 wallet_transactions

    await client.query('COMMIT');
    return normalizeUserCoins(updatedRows[0] as User);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function settleUserModelChargeCoins(
  requestId: string,
  requestTokens: number,
  requestCostCoins: number,
): Promise<ModelChargeSettlementResult> {
  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    const { rows: reservationRows } = await client.query(
      `SELECT * FROM billing_request_reservations
       WHERE request_id = $1
       FOR UPDATE`,
      [requestId],
    );
    const reservation = reservationRows[0]
      ? normalizeBillingRequestReservationRow(
          reservationRows[0] as BillingRequestReservationRow,
        )
      : undefined;
    if (!reservation) {
      throw new Error('预留记录不存在');
    }
    if (reservation.charge_state === 'charged') {
      const existingUser = await getUserByIdUsing(client, reservation.user_id, {
        forUpdate: true,
      });
      if (!existingUser) {
        throw new Error('用户不存在');
      }
      const settlementMetadata = await getModelChargeSettlementMetadataUsing(
        client,
        requestId,
      );
      await client.query('COMMIT');
      return {
        actualChargeCoins: reservation.actual_charge_coins,
        rawChargeCoins:
          settlementMetadata.rawChargeCoins ??
          reservation.total_overage_cost_coins,
        user: normalizeUserCoins(existingUser),
      };
    }

    // per-user advisory lock：明确串行化同一用户的所有结算，避免并发结算
    // 在 INSERT...ON CONFLICT 与 SELECT FOR UPDATE 之间窗口被竞争利用。
    // hashtext 把 TEXT user_id 映射为 int，匹配 advisory_xact_lock(int) 签名。
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('billing:settle:' || $1))",
      [reservation.user_id],
    );

    const user = await getUserByIdUsing(client, reservation.user_id, {
      forUpdate: true,
    });
    if (!user) {
      throw new Error('用户不存在');
    }

    const { rows: monthlyRows } = await client.query(
      `INSERT INTO monthly_billing_state
        (user_id, year_month, billed_overage_tokens, billed_overage_cost_coins,
         updated_at)
       VALUES ($1, $2, 0, 0, NOW())
       ON CONFLICT (user_id, year_month)
       DO UPDATE SET updated_at = monthly_billing_state.updated_at
       RETURNING *`,
      [reservation.user_id, reservation.year_month],
    );
    const monthlyState = normalizeMonthlyBillingStateRow(
      monthlyRows[0] as MonthlyBillingStateRow,
    );
    const previousChargeCoins = toCoins(monthlyState.billed_overage_cost_coins);
    const rawChargeCoins = roundCoinsToCents(Math.max(0, requestCostCoins));
    // Charge actual token usage without a membership allowance.
    // BYOK（自配模型）已在 plans 层结算时短路为 0，不会走到这里。
    // 欠费封顶：单次结算最多把可消费余额扣到 -MAX_OVERDRAFT_COINS，超出部分平台兜底吸收。
    // 入口 arrears 检查会拦住欠费用户的后续请求，此处只为低余额并发门放行的那个请求兜底，
    // 把单账户最坏赊账损失锁死在 MAX_OVERDRAFT_COINS，防止透支任意金额后弃号薅羊毛。
    const normalizedUser = normalizeUserCoins(user);
    const spendableCoins =
      normalizedUser.bonus_coins + normalizedUser.purchased_coins;
    const maxDeductibleCoins = Math.max(
      0,
      spendableCoins + MAX_OVERDRAFT_COINS,
    );
    const actualChargeCoins = roundCoinsToCents(
      Math.min(rawChargeCoins, maxDeductibleCoins),
    );
    const nextChargeCoins = roundCoinsToCents(
      previousChargeCoins + actualChargeCoins,
    );

    // 模型扣费不再请求前冻结余额；结束后按真实 Token 费用入账，可把充值积分扣成负数（有下限）。
    const deduction = await deductModelChargeCoinsAllowDebt(
      client,
      normalizedUser,
      actualChargeCoins,
    );

    await client.query(
      `UPDATE monthly_billing_state
       SET billed_overage_tokens = billed_overage_tokens + $1,
           billed_overage_cost_coins = $2,
           updated_at = NOW()
       WHERE user_id = $3 AND year_month = $4`,
      [
        requestTokens,
        nextChargeCoins,
        reservation.user_id,
        reservation.year_month,
      ],
    );

    await client.query(
      `UPDATE billing_request_reservations
       SET hold_state = CASE WHEN hold_state = 'held' THEN 'released' ELSE hold_state END,
          charge_state = 'charged',
           actual_charge_coins = $2,
           total_overage_tokens = $3,
           total_overage_cost_coins = $4,
           released_at = CASE WHEN hold_state = 'held' THEN NOW() ELSE released_at END,
           charged_at = NOW(),
           updated_at = NOW()
       WHERE request_id = $1`,
      [requestId, actualChargeCoins, requestTokens, rawChargeCoins],
    );

    if (actualChargeCoins > 0) {
      await insertWalletTransaction(client, {
        userId: reservation.user_id,
        kind: 'overage_charge',
        amountCoins: -actualChargeCoins,
        balanceSource: deduction.balanceSource,
        requestId,
        note: '模型 Token 扣费',
        metadata: {
          yearMonth: reservation.year_month,
          requestTokens,
          requestCostCoins: actualChargeCoins,
          rawRequestCostCoins: rawChargeCoins,
          previousChargeCoins,
          nextChargeCoins,
          bonusDeducted: deduction.bonusDeducted,
          purchasedDeducted: deduction.purchasedDeducted,
          grantDeductions: deduction.grantDeductions,
        },
      });
    }

    await client.query('COMMIT');
    return {
      actualChargeCoins,
      rawChargeCoins,
      user: deduction.user,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getMonthlyModelChargeCoins(
  userId: string,
  yearMonth?: string,
): Promise<number> {
  const ym = yearMonth ?? new Date().toISOString().slice(0, 7);
  const { rows } = await getDbPool().query(
    `SELECT COALESCE(billed_overage_cost_coins, 0) AS total
     FROM monthly_billing_state
     WHERE user_id = $1 AND year_month = $2`,
    [userId, ym],
  );
  return Number(
    (rows[0] as { total: string | number } | undefined)?.total ?? 0,
  );
}

/**
 * 批量读取用户指定月份的官方模型扣费。
 *
 * @param userIds 当前页用户 ID 列表。
 * @param yearMonth 月份，格式为 YYYY-MM；不传时使用当前 UTC 月份。
 * @returns userId 到本月扣费积分的映射；无记录的用户返回 0。
 */
export async function getMonthlyModelChargeCoinsByUserIds(
  userIds: string[],
  yearMonth?: string,
): Promise<Map<string, number>> {
  const result = new Map(userIds.map((userId) => [userId, 0]));
  if (userIds.length === 0) return result;
  const ym = yearMonth ?? new Date().toISOString().slice(0, 7);
  const { rows } = await getDbPool().query(
    `SELECT user_id, COALESCE(billed_overage_cost_coins, 0) AS total
     FROM monthly_billing_state
     WHERE user_id = ANY($1::text[])
       AND year_month = $2`,
    [userIds, ym],
  );
  for (const row of rows as Array<{
    user_id: string;
    total: string | number;
  }>) {
    result.set(row.user_id, Number(row.total));
  }
  return result;
}
