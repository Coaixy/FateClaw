import type { User, BalanceGrantSource } from '#shared/types';
import type pg from 'pg';
import {
  roundCoinsToCents,
  assertSufficientSpendableCoins,
} from '#shared/balance-coins';
import { getDbPool } from '#infrastructure/db-pool';
import { getUserByIdUsing } from './users-repository.js';

export function toCoins(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function normalizeUserCoins(row: User): User {
  return {
    ...row,
    purchased_coins: toCoins(row.purchased_coins),
    bonus_coins: toCoins(row.bonus_coins),
    reserved_coins: toCoins(row.reserved_coins),
  };
}

function normalizeWalletTransactionRow(
  row: WalletTransactionRow,
): WalletTransactionRow {
  return {
    ...row,
    amount_coins: toCoins(row.amount_coins),
    reserved_delta_coins: toCoins(row.reserved_delta_coins),
  };
}

function normalizeAdminWalletTransactionRow(
  row: AdminWalletTransactionRow,
): AdminWalletTransactionRow {
  return {
    ...row,
    ...normalizeWalletTransactionRow(row),
    user_phone: row.user_phone ?? null,
  };
}

function normalizeBalanceGrantRow(row: BalanceGrantRow): BalanceGrantRow {
  return {
    ...row,
    amount_coins: toCoins(row.amount_coins),
    remaining_coins: toCoins(row.remaining_coins),
  };
}

export interface WalletTransactionRow {
  id: string;
  user_id: string;
  kind: string;
  amount_coins: number;
  reserved_delta_coins: number;
  balance_source: 'purchased' | 'bonus' | 'mixed' | null;
  balance_grant_id: string | null;
  request_id: string | null;
  note: string | null;
  metadata: unknown;
  created_at: string;
}

/** 管理后台余额流水列表行，附带用户手机号便于人工核对。 */
export interface AdminWalletTransactionRow extends WalletTransactionRow {
  user_phone: string | null;
}

/** 管理后台余额流水列表响应。 */
export interface AdminWalletTransactionListResult {
  transactions: AdminWalletTransactionRow[];
  total: number;
}

/**
 * 根据 wallet_transactions.kind 推断 balance_source。
 * 调用方可覆写（如 overage_charge 的细化为 'bonus'/'purchased'/'mixed'）。
 */
function inferBalanceSourceFromKind(
  kind: string,
): 'purchased' | 'bonus' | 'mixed' | null {
  switch (kind) {
    case 'recharge_topup':
    case 'manual_topup':
    case 'manual_adjustment':
      return 'purchased';
    case 'gift_redeem':
      return null;
    case 'overage_charge':
      return 'mixed';
    case 'reservation_release':
    default:
      return null;
  }
}

export async function insertWalletTransaction(
  client: pg.PoolClient,
  input: {
    userId: string;
    kind: string;
    amountCoins?: number;
    reservedDeltaCoins?: number;
    balanceSource?: 'purchased' | 'bonus' | 'mixed' | null;
    balanceGrantId?: string | null;
    requestId?: string | null;
    note?: string | null;
    metadata?: unknown;
  },
): Promise<string> {
  const amountCoins = roundCoinsToCents(input.amountCoins ?? 0);
  const reservedDeltaCoins = roundCoinsToCents(input.reservedDeltaCoins ?? 0);
  const balanceSource =
    input.balanceSource !== undefined
      ? input.balanceSource
      : inferBalanceSourceFromKind(input.kind);

  const id = `wtx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  await client.query(
    `INSERT INTO wallet_transactions
      (id, user_id, kind,
       amount_coins, reserved_delta_coins, balance_source, balance_grant_id,
       request_id, note, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
    [
      id,
      input.userId,
      input.kind,
      amountCoins,
      reservedDeltaCoins,
      balanceSource,
      input.balanceGrantId ?? null,
      input.requestId ?? null,
      input.note ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ],
  );
  return id;
}

export async function getWalletTransactionsByUserId(
  userId: string,
  limit = 20,
): Promise<WalletTransactionRow[]> {
  const { rows } = await getDbPool().query(
    `SELECT
       id,
       user_id,
       kind,
       amount_coins::float8 AS amount_coins,
       reserved_delta_coins::float8 AS reserved_delta_coins,
       balance_source,
       balance_grant_id,
       request_id,
       note,
       metadata,
       created_at
     FROM wallet_transactions
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit],
  );
  return (rows as WalletTransactionRow[]).map(normalizeWalletTransactionRow);
}

/**
 * 查询管理后台使用的全局余额流水列表。
 *
 * @param opts - 可按用户和流水类型筛选，并支持分页。
 * @returns 余额流水列表与匹配总数；每行附带用户手机号。
 */
export async function listWalletTransactionsForAdmin(
  opts: {
    userId?: string;
    kind?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<AdminWalletTransactionListResult> {
  const where: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (opts.userId) {
    where.push(`wt.user_id = $${idx++}`);
    values.push(opts.userId);
  }
  if (opts.kind) {
    where.push(`wt.kind = $${idx++}`);
    values.push(opts.kind);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(opts.limit ?? 80, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  const { rows: countRows } = await getDbPool().query(
    `SELECT COUNT(*) AS cnt
     FROM wallet_transactions wt
     ${whereClause}`,
    values,
  );

  const { rows } = await getDbPool().query(
    `SELECT wt.id,
            wt.user_id,
            wt.kind,
            wt.amount_coins::float8 AS amount_coins,
            wt.reserved_delta_coins::float8 AS reserved_delta_coins,
            wt.balance_source,
            wt.balance_grant_id,
            wt.request_id,
            wt.note,
            wt.metadata,
            wt.created_at,
            u.phone AS user_phone
     FROM wallet_transactions wt
     LEFT JOIN users u ON u.id = wt.user_id
     ${whereClause}
     ORDER BY wt.created_at DESC
     LIMIT $${idx++} OFFSET $${idx++}`,
    [...values, limit, offset],
  );

  return {
    transactions: (rows as AdminWalletTransactionRow[]).map(
      normalizeAdminWalletTransactionRow,
    ),
    total: Number((countRows[0] as { cnt: string }).cnt),
  };
}

export async function getVisibleWalletTransactionsByUserId(
  userId: string,
  limit = 20,
): Promise<WalletTransactionRow[]> {
  const { rows } = await getDbPool().query(
    `SELECT
       id,
       user_id,
       kind,
       amount_coins::float8 AS amount_coins,
       reserved_delta_coins::float8 AS reserved_delta_coins,
       balance_source,
       balance_grant_id,
       request_id,
       note,
       metadata,
       created_at
     FROM wallet_transactions
     WHERE user_id = $1
       AND amount_coins <> 0
       AND kind <> 'overage_charge'
       AND kind <> 'skill_subscription'
       AND kind <> 'bundle_subscription'
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit],
  );
  return (rows as WalletTransactionRow[]).map(normalizeWalletTransactionRow);
}

export interface BalanceGrantRow {
  id: string;
  user_id: string;
  source: string;
  granted_by: string | null;
  amount_coins: number;
  remaining_coins: number;
  note: string | null;
  expires_at: string | null;
  status: 'active' | 'exhausted' | 'expired' | 'revoked';
  created_at: string;
  updated_at: string;
}

/**
 * 查询用户当前活跃的赠送积分批次，按"最快过期的在前"排序。
 * 永不过期（expires_at IS NULL）排在最后，保证临期批次优先扣减。
 *
 * 调用方必须已在事务中并持有 users 行的 FOR UPDATE 锁；
 * 本函数内部对批次行 FOR UPDATE 加锁以防并发扣减。
 */
async function getAvailableBonusBatches(
  client: pg.PoolClient,
  userId: string,
  chargeCoins: number,
): Promise<BalanceGrantRow[]> {
  const { rows } = await client.query(
    `WITH ordered AS (
       SELECT
         id,
         COALESCE(
           SUM(remaining_coins) OVER (
             ORDER BY expires_at ASC NULLS LAST, created_at ASC, id ASC
             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
           ),
           0
         ) AS coins_before
       FROM balance_grants
       WHERE user_id = $1
         AND status = 'active'
         AND remaining_coins > 0
         AND (expires_at IS NULL OR expires_at > NOW())
     ),
     selected AS (
       SELECT id
       FROM ordered
       WHERE coins_before < $2
     )
     SELECT bg.*
     FROM balance_grants bg
     JOIN selected ON selected.id = bg.id
     ORDER BY bg.expires_at ASC NULLS LAST, bg.created_at ASC, bg.id ASC
     FOR UPDATE OF bg`,
    [userId, chargeCoins],
  );
  return (rows as BalanceGrantRow[]).map(normalizeBalanceGrantRow);
}

export interface DeductBalanceResult {
  bonusDeducted: number;
  purchasedDeducted: number;
  grantDeductions: Array<{ grantId: string; coins: number }>;
  balanceSource: 'purchased' | 'bonus' | 'mixed' | null;
}

async function deductBonusGrantsBestEffort(
  client: pg.PoolClient,
  userId: string,
  chargeCoins: number,
): Promise<{
  bonusDeducted: number;
  remainingChargeCoins: number;
  grantDeductions: Array<{ grantId: string; coins: number }>;
}> {
  let bonusLeft = roundCoinsToCents(Math.max(0, chargeCoins));
  const grantDeductions: Array<{ grantId: string; coins: number }> = [];

  const batches = await getAvailableBonusBatches(client, userId, bonusLeft);
  for (const batch of batches) {
    if (bonusLeft <= 0) break;
    const toDeduct = roundCoinsToCents(
      Math.min(batch.remaining_coins, bonusLeft),
    );
    if (toDeduct <= 0) continue;
    await client.query(
      `UPDATE balance_grants
       SET remaining_coins = remaining_coins - $1,
           status = CASE WHEN remaining_coins - $1 <= 0 THEN 'exhausted' ELSE status END,
           updated_at = NOW()
       WHERE id = $2`,
      [toDeduct, batch.id],
    );
    grantDeductions.push({ grantId: batch.id, coins: toDeduct });
    bonusLeft = roundCoinsToCents(bonusLeft - toDeduct);
  }

  return {
    bonusDeducted: roundCoinsToCents(Math.max(0, chargeCoins) - bonusLeft),
    remainingChargeCoins: bonusLeft,
    grantDeductions,
  };
}

/**
 * 内部扣减算法：在一次事务中按 bonus → purchased 顺序扣减余额，
 * 并维护 balance_grants.remaining_coins / users.{bonus_coins,purchased_coins}。
 * 返回的 balanceSource 会作为 wallet_transactions.balance_source 写入流水。
 */
export async function deductBalanceCoins(
  client: pg.PoolClient,
  user: User,
  chargeCoins: number,
  options?: { releasedReservedCoins?: number },
): Promise<DeductBalanceResult> {
  if (chargeCoins <= 0) {
    return {
      bonusDeducted: 0,
      purchasedDeducted: 0,
      grantDeductions: [],
      balanceSource: null,
    };
  }
  assertSufficientSpendableCoins(user, chargeCoins, options);

  const { bonusDeducted, remainingChargeCoins, grantDeductions } =
    await deductBonusGrantsBestEffort(client, user.id, chargeCoins);
  const purchasedDeducted = remainingChargeCoins;
  if (
    user.bonus_coins < bonusDeducted ||
    user.purchased_coins < purchasedDeducted
  ) {
    throw new Error('积分不足，请补充积分后继续使用');
  }

  // 更新 users 表的桶字段
  await client.query(
    `UPDATE users
     SET bonus_coins = bonus_coins - $1,
         purchased_coins = purchased_coins - $2
     WHERE id = $3`,
    [bonusDeducted, purchasedDeducted, user.id],
  );

  let balanceSource: DeductBalanceResult['balanceSource'];
  if (bonusDeducted > 0 && purchasedDeducted > 0) balanceSource = 'mixed';
  else if (bonusDeducted > 0) balanceSource = 'bonus';
  else if (purchasedDeducted > 0) balanceSource = 'purchased';
  else balanceSource = null;

  return {
    bonusDeducted,
    purchasedDeducted,
    grantDeductions,
    balanceSource,
  };
}

/**
 * 模型请求结束后扣费，允许充值积分被扣成负数。
 * 只有后续请求入口会因为欠费被拦截，当前请求的实际 Token 成本仍完整入账。
 */
export async function deductModelChargeCoinsAllowDebt(
  client: pg.PoolClient,
  user: User,
  chargeCoins: number,
): Promise<DeductBalanceResult & { user: User }> {
  if (chargeCoins <= 0) {
    return {
      bonusDeducted: 0,
      purchasedDeducted: 0,
      grantDeductions: [],
      balanceSource: null,
      user,
    };
  }

  const { bonusDeducted, remainingChargeCoins, grantDeductions } =
    await deductBonusGrantsBestEffort(client, user.id, chargeCoins);
  const purchasedDeducted = remainingChargeCoins;

  const { rows: updatedRows } = await client.query(
    `UPDATE users
     SET bonus_coins = GREATEST(0, bonus_coins - $1),
         purchased_coins = purchased_coins - $2
     WHERE id = $3
     RETURNING *`,
    [bonusDeducted, purchasedDeducted, user.id],
  );

  let balanceSource: DeductBalanceResult['balanceSource'];
  if (bonusDeducted > 0 && purchasedDeducted > 0) balanceSource = 'mixed';
  else if (bonusDeducted > 0) balanceSource = 'bonus';
  else if (purchasedDeducted > 0) balanceSource = 'purchased';
  else balanceSource = null;

  return {
    bonusDeducted,
    purchasedDeducted,
    grantDeductions,
    balanceSource,
    user: normalizeUserCoins(updatedRows[0] as User),
  };
}

/**
 * 赠送积分（新用户礼包、签到奖励、活动余额、管理员手动发放）。
 * 原子操作：创建 balance_grants 行 → 更新 users.bonus_coins → 写流水。
 */
export async function grantBonusBalance(input: {
  userId: string;
  source: BalanceGrantSource | string;
  amountCoins: number;
  expiresAt?: string | null;
  note?: string | null;
  grantedBy?: string | null;
}): Promise<{ user: User; grantId: string }> {
  if (input.amountCoins <= 0) {
    throw new Error('赠送积分必须为正');
  }
  const grantId = `bg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    const user = await getUserByIdUsing(client, input.userId, {
      forUpdate: true,
    });
    if (!user) throw new Error('用户不存在');

    await client.query(
      `INSERT INTO balance_grants
         (id, user_id, source, granted_by, amount_coins, remaining_coins,
          note, expires_at, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5, $6, $7, 'active', NOW(), NOW())`,
      [
        grantId,
        input.userId,
        input.source,
        input.grantedBy ?? null,
        input.amountCoins,
        input.note ?? null,
        input.expiresAt ?? null,
      ],
    );

    const { rows: updatedRows } = await client.query(
      `UPDATE users
       SET bonus_coins = bonus_coins + $1
       WHERE id = $2
       RETURNING *`,
      [input.amountCoins, input.userId],
    );

    await insertWalletTransaction(client, {
      userId: input.userId,
      kind: 'bonus_grant',
      amountCoins: input.amountCoins,
      balanceSource: 'bonus',
      balanceGrantId: grantId,
      note: input.note ?? `赠送积分（${input.source}）`,
      metadata: {
        source: input.source,
        grantedBy: input.grantedBy ?? null,
        expiresAt: input.expiresAt ?? null,
      },
    });

    await client.query('COMMIT');
    return {
      user: normalizeUserCoins(updatedRows[0] as User),
      grantId,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 在读取用户钱包前同步该用户已过期赠送批次。
 *
 * 全局过期扫描可能延迟，入口余额判断必须先校准，否则已过期 bonus 会继续掩盖欠费。
 */
export async function expireUserBonusBalanceBefore(
  userId: string,
  beforeIso: string,
): Promise<{ expired: number; totalCoinsExpired: number }> {
  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    const user = await getUserByIdUsing(client, userId, { forUpdate: true });
    if (!user) {
      await client.query('COMMIT');
      return { expired: 0, totalCoinsExpired: 0 };
    }

    const { rows } = await client.query(
      `SELECT * FROM balance_grants
       WHERE user_id = $1
         AND status = 'active'
         AND remaining_coins > 0
         AND expires_at IS NOT NULL
         AND expires_at < $2
       ORDER BY expires_at ASC, created_at ASC
       FOR UPDATE`,
      [userId, beforeIso],
    );
    const batches = (rows as BalanceGrantRow[]).map(normalizeBalanceGrantRow);
    const totalCoinsExpired = roundCoinsToCents(
      batches.reduce((sum, batch) => sum + batch.remaining_coins, 0),
    );
    if (batches.length === 0 || totalCoinsExpired <= 0) {
      await client.query('COMMIT');
      return { expired: 0, totalCoinsExpired: 0 };
    }

    const grantIds = batches.map((batch) => batch.id);
    await client.query(
      `UPDATE balance_grants
       SET status = 'expired',
           remaining_coins = 0,
           updated_at = NOW()
       WHERE id = ANY($1::text[])`,
      [grantIds],
    );
    await client.query(
      `UPDATE users
       SET bonus_coins = GREATEST(0, bonus_coins - $1)
       WHERE id = $2`,
      [totalCoinsExpired, userId],
    );

    for (const batch of batches) {
      await insertWalletTransaction(client, {
        userId,
        kind: 'bonus_expire',
        amountCoins: -batch.remaining_coins,
        balanceSource: 'bonus',
        balanceGrantId: batch.id,
        note: `赠送积分过期（批次 ${batch.id}）`,
        metadata: {
          batch_source: batch.source,
          expires_at: batch.expires_at,
          original_amount: batch.amount_coins,
          source: 'user_wallet_sync',
        },
      });
    }

    await client.query('COMMIT');
    return { expired: batches.length, totalCoinsExpired };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getBalanceGrantsByUserId(
  userId: string,
  opts?: { includeExhausted?: boolean; limit?: number },
): Promise<BalanceGrantRow[]> {
  const where: string[] = ['user_id = $1'];
  if (!opts?.includeExhausted) {
    where.push(`status = 'active'`);
  }
  const { rows } = await getDbPool().query(
    `SELECT * FROM balance_grants
     WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, Math.min(opts?.limit ?? 50, 200)],
  );
  return (rows as BalanceGrantRow[]).map(normalizeBalanceGrantRow);
}

/**
 * 管理员调整用户的充值积分（purchased_coins）。
 */
export async function adjustUserPurchasedBalance(
  userId: string,
  amountCoins: number,
  note?: string | null,
): Promise<User> {
  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    const user = await getUserByIdUsing(client, userId, {
      forUpdate: true,
    });
    if (!user) {
      throw new Error('用户不存在');
    }

    const nextPurchased = roundCoinsToCents(user.purchased_coins + amountCoins);

    const { rows: updatedRows } = await client.query(
      `UPDATE users
       SET purchased_coins = $1
       WHERE id = $2
       RETURNING *`,
      [nextPurchased, userId],
    );

    await insertWalletTransaction(client, {
      userId,
      kind: amountCoins >= 0 ? 'manual_topup' : 'manual_adjustment',
      amountCoins,
      balanceSource: 'purchased',
      note: note ?? null,
      metadata: { source: 'admin' },
    });

    await client.query('COMMIT');
    return normalizeUserCoins(updatedRows[0] as User);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
