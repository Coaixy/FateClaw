import pg from 'pg';

import { getDbPool } from '../db-pool.js';
import { logger } from '../logger.js';
import { getUserByIdUsing } from './users-repository.js';
import type { BalanceGrantSource, User } from '../../shared/types.js';
import {
  assertSufficientSpendableCents,
  calculateAvailableSpendableCents,
} from '../../shared/balance-cents.js';

const pool = {
  query(sql: string, params?: unknown[]) {
    return getDbPool().query(sql, params);
  },
  connect() {
    return getDbPool().connect();
  },
};

export interface WalletTransactionRow {
  id: string;
  user_id: string;
  kind: string;
  amount_cents: number;
  reserved_delta_cents: number;
  balance_source: 'purchased' | 'bonus' | 'mixed' | null;
  balance_grant_id: string | null;
  request_id: string | null;
  note: string | null;
  metadata: unknown;
  created_at: string;
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
    case 'overage_charge':
    case 'skill_subscription':
    case 'bundle_subscription':
      return 'mixed';
    case 'reservation_release':
    default:
      return null;
  }
}

export interface MonthlyBillingStateRow {
  user_id: string;
  year_month: string;
  billed_overage_tokens: number;
  billed_overage_cost_cents: number;
  updated_at: string;
}

export interface BillingRequestReservationRow {
  request_id: string;
  user_id: string;
  model_config_id: string | null;
  year_month: string;
  reserved_cents: number;
  hold_state: 'none' | 'held' | 'released';
  charge_state: 'pending' | 'charged';
  actual_charge_cents: number;
  total_overage_tokens: number;
  total_overage_cost_cents: number;
  note: string | null;
  metadata: unknown;
  released_at: string | null;
  charged_at: string | null;
  created_at: string;
  updated_at: string;
}

export type RechargePayType = 'alipay' | 'wechat';
export type RechargeOrderStatus = 'pending' | 'paid' | 'failed';

export interface RechargeOrderRow {
  id: string;
  user_id: string;
  trade_id: string;
  provider: 'epay' | string;
  provider_trade_id: string | null;
  pay_type: RechargePayType;
  amount_yuan: string;
  amount_cents: number;
  pay_url: string | null;
  status: RechargeOrderStatus;
  paid_at: string | null;
  notified_at: string | null;
  metadata: unknown;
  created_at: string;
  updated_at: string;
}

export interface RechargeStatsRow {
  total_paid_orders: number;
  total_recharge_cents: number;
  total_recharge_yuan: string;
  last_paid_at: string | null;
}

export interface RechargePaymentConfigRow {
  id: 'default' | string;
  enabled: boolean;
  min_yuan: string;
  max_yuan: string;
  epay_url_prefix: string;
  epay_platform_id: number | null;
  epay_merchant_private_key: string;
  epay_platform_public_key: string;
  epay_merchant_key: string;
  notify_url: string;
  return_url: string;
  updated_at: string;
}

/** 每日签到软妹币奖励的全局配置行。 */
export interface DailySignInConfigRow {
  id: 'default' | string;
  enabled: boolean;
  reward_cents: number;
  updated_at: string;
}

/** 用户每日签到记录，依靠 user_id + sign_in_date 保证每日幂等。 */
export interface DailySignInRecordRow {
  id: string;
  user_id: string;
  sign_in_date: string;
  reward_cents: number;
  balance_grant_id: string | null;
  created_at: string;
}

/**
 * 读取全局每日签到配置；首次访问时补齐默认配置行。
 */
export async function getDailySignInConfig(): Promise<DailySignInConfigRow> {
  const { rows } = await pool.query(
    `INSERT INTO daily_sign_in_config (id)
     VALUES ('default')
     ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
     RETURNING *`,
  );
  return rows[0] as DailySignInConfigRow;
}

/**
 * 更新每日签到开关和每次奖励的软妹币分值。
 */
export async function updateDailySignInConfig(input: {
  enabled: boolean;
  rewardCents: number;
}): Promise<DailySignInConfigRow> {
  const { rows } = await pool.query(
    `INSERT INTO daily_sign_in_config (
       id, enabled, reward_cents, updated_at
     )
     VALUES ('default', $1, $2, NOW())
     ON CONFLICT (id) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       reward_cents = EXCLUDED.reward_cents,
       updated_at = NOW()
     RETURNING *`,
    [input.enabled, input.rewardCents],
  );
  return rows[0] as DailySignInConfigRow;
}

/**
 * 查询用户某个自然日是否已经签到。
 */
export async function getDailySignInRecordByDate(
  userId: string,
  signInDate: string,
): Promise<DailySignInRecordRow | undefined> {
  const { rows } = await pool.query(
    `SELECT *
     FROM daily_sign_in_records
     WHERE user_id = $1 AND sign_in_date = $2`,
    [userId, signInDate],
  );
  return rows[0] as DailySignInRecordRow | undefined;
}

export async function insertWalletTransaction(
  client: pg.PoolClient,
  input: {
    userId: string;
    kind: string;
    amountCents?: number;
    reservedDeltaCents?: number;
    balanceSource?: 'purchased' | 'bonus' | 'mixed' | null;
    balanceGrantId?: string | null;
    requestId?: string | null;
    note?: string | null;
    metadata?: unknown;
  },
): Promise<void> {
  const amountCents = input.amountCents ?? 0;
  const reservedDeltaCents = input.reservedDeltaCents ?? 0;
  const balanceSource =
    input.balanceSource !== undefined
      ? input.balanceSource
      : inferBalanceSourceFromKind(input.kind);

  // amount_cents / reserved_delta_cents 列仍存在（未 DROP），
  // 但不再由业务写入——DB DEFAULT 0 承接，直到 Stage 5 移除该列
  await client.query(
    `INSERT INTO wallet_transactions
      (id, user_id, kind,
       amount_cents, reserved_delta_cents, balance_source, balance_grant_id,
       request_id, note, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
    [
      `wtx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      input.userId,
      input.kind,
      amountCents,
      reservedDeltaCents,
      balanceSource,
      input.balanceGrantId ?? null,
      input.requestId ?? null,
      input.note ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ],
  );
}

export async function getRechargePaymentConfig(): Promise<RechargePaymentConfigRow> {
  const { rows } = await pool.query(
    `INSERT INTO recharge_payment_config (id)
     VALUES ('default')
     ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
     RETURNING *`,
  );
  return rows[0] as RechargePaymentConfigRow;
}

export async function updateRechargePaymentConfig(input: {
  enabled: boolean;
  minYuan: string;
  maxYuan: string;
  epayUrlPrefix: string;
  epayPlatformId: number | null;
  epayMerchantPrivateKey: string;
  epayPlatformPublicKey: string;
  epayMerchantKey: string;
  notifyUrl: string;
  returnUrl: string;
}): Promise<RechargePaymentConfigRow> {
  const { rows } = await pool.query(
    `INSERT INTO recharge_payment_config (
       id, enabled, min_yuan, max_yuan, epay_url_prefix, epay_platform_id,
       epay_merchant_private_key, epay_platform_public_key, epay_merchant_key,
       notify_url, return_url, updated_at
     )
     VALUES ('default', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
     ON CONFLICT (id) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       min_yuan = EXCLUDED.min_yuan,
       max_yuan = EXCLUDED.max_yuan,
       epay_url_prefix = EXCLUDED.epay_url_prefix,
       epay_platform_id = EXCLUDED.epay_platform_id,
       epay_merchant_private_key = EXCLUDED.epay_merchant_private_key,
       epay_platform_public_key = EXCLUDED.epay_platform_public_key,
       epay_merchant_key = EXCLUDED.epay_merchant_key,
       notify_url = EXCLUDED.notify_url,
       return_url = EXCLUDED.return_url,
       updated_at = NOW()
     RETURNING *`,
    [
      input.enabled,
      input.minYuan,
      input.maxYuan,
      input.epayUrlPrefix,
      input.epayPlatformId,
      input.epayMerchantPrivateKey,
      input.epayPlatformPublicKey,
      input.epayMerchantKey,
      input.notifyUrl,
      input.returnUrl,
    ],
  );
  return rows[0] as RechargePaymentConfigRow;
}

/**
 * 为用户创建每日签到奖励。
 *
 * 该函数在同一事务内创建签到记录、赠送余额批次、用户余额和钱包流水；
 * 如果当天已经签到，直接返回已有记录而不重复发放软妹币。
 */
export async function createDailySignInReward(input: {
  userId: string;
  signInDate: string;
  rewardCents: number;
  note?: string | null;
}): Promise<{ user: User; record: DailySignInRecordRow; created: boolean }> {
  if (input.rewardCents <= 0) {
    throw new Error('签到奖励必须大于 0');
  }
  const recordId = `signin-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const grantId = `bg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await getUserByIdUsing(client, input.userId, {
      forUpdate: true,
    });
    if (!user) throw new Error('用户不存在');

    const { rows: insertedRows } = await client.query(
      `INSERT INTO daily_sign_in_records
         (id, user_id, sign_in_date, reward_cents, balance_grant_id, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (user_id, sign_in_date) DO NOTHING
       RETURNING *`,
      [recordId, input.userId, input.signInDate, input.rewardCents, grantId],
    );
    const inserted = insertedRows[0] as DailySignInRecordRow | undefined;
    if (!inserted) {
      const { rows: existingRows } = await client.query(
        `SELECT *
         FROM daily_sign_in_records
         WHERE user_id = $1 AND sign_in_date = $2`,
        [input.userId, input.signInDate],
      );
      await client.query('COMMIT');
      return {
        user,
        record: existingRows[0] as DailySignInRecordRow,
        created: false,
      };
    }

    await client.query(
      `INSERT INTO balance_grants
         (id, user_id, source, granted_by, amount_cents, remaining_cents,
          note, expires_at, status, created_at, updated_at)
       VALUES ($1, $2, 'sign_in', NULL, $3, $3, $4, NULL, 'active', NOW(), NOW())`,
      [grantId, input.userId, input.rewardCents, input.note ?? null],
    );

    const { rows: updatedRows } = await client.query(
      `UPDATE users
       SET bonus_cents = bonus_cents + $1
       WHERE id = $2
       RETURNING *`,
      [input.rewardCents, input.userId],
    );

    await insertWalletTransaction(client, {
      userId: input.userId,
      kind: 'bonus_grant',
      amountCents: input.rewardCents,
      balanceSource: 'bonus',
      balanceGrantId: grantId,
      note: input.note ?? `每日签到奖励（${input.signInDate}）`,
      metadata: {
        source: 'sign_in',
        signInDate: input.signInDate,
      },
    });

    await client.query('COMMIT');
    return {
      user: updatedRows[0] as User,
      record: inserted,
      created: true,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function insertRechargeOrder(input: {
  id: string;
  userId: string;
  tradeId: string;
  payType: RechargePayType;
  amountYuan: string;
  amountCents: number;
  metadata?: unknown;
}): Promise<RechargeOrderRow> {
  const { rows } = await pool.query(
    `INSERT INTO recharge_orders
       (id, user_id, trade_id, provider, pay_type, amount_yuan,
        amount_cents, status, metadata, created_at, updated_at)
     VALUES ($1, $2, $3, 'epay', $4, $5, $6, 'pending', $7, NOW(), NOW())
     RETURNING *`,
    [
      input.id,
      input.userId,
      input.tradeId,
      input.payType,
      input.amountYuan,
      input.amountCents,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ],
  );
  return rows[0] as RechargeOrderRow;
}

export async function markRechargeOrderPaymentCreated(input: {
  tradeId: string;
  providerTradeId?: string | null;
  payUrl: string;
  metadata?: unknown;
}): Promise<RechargeOrderRow> {
  const { rows } = await pool.query(
    `UPDATE recharge_orders
     SET provider_trade_id = COALESCE($2, provider_trade_id),
         pay_url = $3,
         metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb,
         updated_at = NOW()
     WHERE trade_id = $1
     RETURNING *`,
    [
      input.tradeId,
      input.providerTradeId ?? null,
      input.payUrl,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  if (rows.length === 0) {
    throw new Error('充值单不存在');
  }
  return rows[0] as RechargeOrderRow;
}

export async function markRechargeOrderFailed(
  tradeId: string,
  reason: string,
): Promise<void> {
  await pool.query(
    `UPDATE recharge_orders
     SET status = 'failed',
         metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
         updated_at = NOW()
     WHERE trade_id = $1 AND status = 'pending'`,
    [tradeId, JSON.stringify({ failure_reason: reason })],
  );
}

export async function getRechargeOrderByTradeId(
  tradeId: string,
): Promise<RechargeOrderRow | undefined> {
  const { rows } = await pool.query(
    `SELECT * FROM recharge_orders WHERE trade_id = $1`,
    [tradeId],
  );
  return rows[0] as RechargeOrderRow | undefined;
}

export async function getRechargeOrderByTradeIdForUser(
  userId: string,
  tradeId: string,
): Promise<RechargeOrderRow | undefined> {
  const { rows } = await pool.query(
    `SELECT * FROM recharge_orders
     WHERE user_id = $1 AND trade_id = $2`,
    [userId, tradeId],
  );
  return rows[0] as RechargeOrderRow | undefined;
}

export async function listRechargeOrdersByUserId(
  userId: string,
  limit = 20,
): Promise<RechargeOrderRow[]> {
  const { rows } = await pool.query(
    `SELECT * FROM recharge_orders
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, Math.min(Math.max(limit, 1), 100)],
  );
  return rows as RechargeOrderRow[];
}

export async function getRechargeStatsByUserId(
  userId: string,
): Promise<RechargeStatsRow> {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'paid')::int AS total_paid_orders,
       COALESCE(SUM(amount_cents) FILTER (WHERE status = 'paid'), 0)::int
         AS total_recharge_cents,
       COALESCE(SUM(amount_yuan) FILTER (WHERE status = 'paid'), 0)::text
         AS total_recharge_yuan,
       MAX(paid_at) FILTER (WHERE status = 'paid') AS last_paid_at
     FROM recharge_orders
     WHERE user_id = $1`,
    [userId],
  );
  return rows[0] as RechargeStatsRow;
}

export async function settleRechargeOrderPaid(input: {
  tradeId: string;
  providerTradeId?: string | null;
  payType?: RechargePayType | null;
  paidAt?: string | Date | null;
  notifyPayload?: unknown;
}): Promise<RechargeOrderRow> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: orderRows } = await client.query(
      `SELECT * FROM recharge_orders
       WHERE trade_id = $1
       FOR UPDATE`,
      [input.tradeId],
    );
    const order = orderRows[0] as RechargeOrderRow | undefined;
    if (!order) {
      throw new Error('充值单不存在');
    }

    // 支付平台通知可能重复到达，已入账订单直接返回，保证幂等。
    if (order.status === 'paid') {
      await client.query('COMMIT');
      return order;
    }
    if (order.status !== 'pending') {
      throw new Error('充值单状态不可入账');
    }

    await client.query(
      `UPDATE users
       SET purchased_cents = purchased_cents + $1
       WHERE id = $2`,
      [order.amount_cents, order.user_id],
    );

    await insertWalletTransaction(client, {
      userId: order.user_id,
      kind: 'recharge_topup',
      amountCents: order.amount_cents,
      balanceSource: 'purchased',
      requestId: order.trade_id,
      note: `充值到账软妹币 ${order.amount_yuan}`,
      metadata: {
        trade_id: order.trade_id,
        provider: order.provider,
        provider_trade_id: input.providerTradeId ?? order.provider_trade_id,
        pay_type: input.payType ?? order.pay_type,
      },
    });

    const { rows: updatedRows } = await client.query(
      `UPDATE recharge_orders
       SET status = 'paid',
           provider_trade_id = COALESCE($2, provider_trade_id),
           pay_type = COALESCE($3::text, pay_type),
           paid_at = COALESCE($4::timestamptz, NOW()),
           notified_at = NOW(),
           metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb,
           updated_at = NOW()
       WHERE trade_id = $1
       RETURNING *`,
      [
        order.trade_id,
        input.providerTradeId ?? null,
        input.payType ?? null,
        input.paidAt ?? null,
        JSON.stringify({ notify_payload: input.notifyPayload ?? null }),
      ],
    );

    await client.query('COMMIT');
    return updatedRows[0] as RechargeOrderRow;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function insertBillingRequestReservation(
  client: pg.PoolClient,
  input: {
    requestId: string;
    userId: string;
    modelConfigId?: string | null;
    yearMonth: string;
    reservedCents: number;
    holdState: BillingRequestReservationRow['hold_state'];
    note?: string | null;
    metadata?: unknown;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO billing_request_reservations
      (request_id, user_id, model_config_id, year_month, reserved_cents,
       hold_state, charge_state, note, metadata, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, NOW(), NOW())
     ON CONFLICT (request_id) DO NOTHING`,
    [
      input.requestId,
      input.userId,
      input.modelConfigId ?? null,
      input.yearMonth,
      input.reservedCents,
      input.holdState,
      input.note ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ],
  );
}

export async function getBillingRequestReservationByRequestId(
  requestId: string,
): Promise<BillingRequestReservationRow | undefined> {
  const { rows } = await pool.query(
    'SELECT * FROM billing_request_reservations WHERE request_id = $1',
    [requestId],
  );
  return rows[0] as BillingRequestReservationRow | undefined;
}

export async function listBillingRequestReservations(opts?: {
  userId?: string;
  holdState?: BillingRequestReservationRow['hold_state'];
  chargeState?: BillingRequestReservationRow['charge_state'];
  limit?: number;
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
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM billing_request_reservations
     ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${idx}`,
    values,
  );
  return rows as BillingRequestReservationRow[];
}

export async function reconcileStaleBillingReservations(
  staleBeforeIso: string,
  limit = 100,
): Promise<{ released: number; requestIds: string[] }> {
  const rows = await listBillingRequestReservations({
    holdState: 'held',
    chargeState: 'pending',
    limit,
  });
  let released = 0;
  const requestIds: string[] = [];

  for (const row of rows) {
    if (new Date(row.updated_at).toISOString() > staleBeforeIso) continue;
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

export async function getWalletTransactionsByUserId(
  userId: string,
  limit = 20,
): Promise<WalletTransactionRow[]> {
  const { rows } = await pool.query(
    `SELECT * FROM wallet_transactions
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit],
  );
  return rows as WalletTransactionRow[];
}

export async function getVisibleWalletTransactionsByUserId(
  userId: string,
  limit = 20,
): Promise<WalletTransactionRow[]> {
  const { rows } = await pool.query(
    `SELECT * FROM wallet_transactions
     WHERE user_id = $1
       AND amount_cents <> 0
       AND kind <> 'overage_charge'
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit],
  );
  return rows as WalletTransactionRow[];
}

// =====================
// --- Balance grants / 余额扣减算法 ---
// =====================

export interface BalanceGrantRow {
  id: string;
  user_id: string;
  source: string;
  granted_by: string | null;
  amount_cents: number;
  remaining_cents: number;
  note: string | null;
  expires_at: string | null;
  status: 'active' | 'exhausted' | 'expired' | 'revoked';
  created_at: string;
  updated_at: string;
}

/**
 * 查询用户当前活跃的赠送余额批次，按"最快过期的在前"排序。
 * 永不过期（expires_at IS NULL）排在最后，保证临期批次优先扣减。
 *
 * 调用方必须已在事务中并持有 users 行的 FOR UPDATE 锁；
 * 本函数内部对批次行 FOR UPDATE 加锁以防并发扣减。
 */
async function getAvailableBonusBatches(
  client: pg.PoolClient,
  userId: string,
): Promise<BalanceGrantRow[]> {
  const { rows } = await client.query(
    `SELECT * FROM balance_grants
     WHERE user_id = $1
       AND status = 'active'
       AND remaining_cents > 0
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY expires_at ASC NULLS LAST, created_at ASC
     FOR UPDATE`,
    [userId],
  );
  return rows as BalanceGrantRow[];
}

export interface DeductBalanceResult {
  bonusDeducted: number;
  purchasedDeducted: number;
  grantDeductions: Array<{ grantId: string; cents: number }>;
  balanceSource: 'purchased' | 'bonus' | 'mixed' | null;
}

/**
 * 内部扣减算法：在一次事务中按 bonus → purchased 顺序扣减余额，
 * 并维护 balance_grants.remaining_cents / users.{bonus_cents,purchased_cents}。
 * 返回的 balanceSource 会作为 wallet_transactions.balance_source 写入流水。
 */
export async function deductBalanceCents(
  client: pg.PoolClient,
  user: User,
  chargeCents: number,
  options?: { releasedReservedCents?: number },
): Promise<DeductBalanceResult> {
  if (chargeCents <= 0) {
    return {
      bonusDeducted: 0,
      purchasedDeducted: 0,
      grantDeductions: [],
      balanceSource: null,
    };
  }
  assertSufficientSpendableCents(user, chargeCents, options);

  let bonusLeft = chargeCents;
  const grantDeductions: Array<{ grantId: string; cents: number }> = [];

  const batches = await getAvailableBonusBatches(client, user.id);
  for (const batch of batches) {
    if (bonusLeft <= 0) break;
    const toDeduct = Math.min(batch.remaining_cents, bonusLeft);
    if (toDeduct <= 0) continue;
    await client.query(
      `UPDATE balance_grants
       SET remaining_cents = remaining_cents - $1,
           status = CASE WHEN remaining_cents - $1 <= 0 THEN 'exhausted' ELSE status END,
           updated_at = NOW()
       WHERE id = $2`,
      [toDeduct, batch.id],
    );
    grantDeductions.push({ grantId: batch.id, cents: toDeduct });
    bonusLeft -= toDeduct;
  }

  const bonusDeducted = chargeCents - bonusLeft;
  const purchasedDeducted = bonusLeft;
  if (
    user.bonus_cents < bonusDeducted ||
    user.purchased_cents < purchasedDeducted
  ) {
    throw new Error('余额不足，请充值后继续使用');
  }

  // 更新 users 表的桶字段
  await client.query(
    `UPDATE users
     SET bonus_cents = bonus_cents - $1,
         purchased_cents = purchased_cents - $2
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
 * 赠送余额（新用户礼包、签到奖励、活动余额、管理员手动发放）。
 * 原子操作：创建 balance_grants 行 → 更新 users.bonus_cents → 写流水。
 */
export async function grantBonusBalance(input: {
  userId: string;
  source: BalanceGrantSource | string;
  amountCents: number;
  expiresAt?: string | null;
  note?: string | null;
  grantedBy?: string | null;
}): Promise<{ user: User; grantId: string }> {
  if (input.amountCents <= 0) {
    throw new Error('赠送余额必须为正');
  }
  const grantId = `bg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await getUserByIdUsing(client, input.userId, {
      forUpdate: true,
    });
    if (!user) throw new Error('用户不存在');

    await client.query(
      `INSERT INTO balance_grants
         (id, user_id, source, granted_by, amount_cents, remaining_cents,
          note, expires_at, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5, $6, $7, 'active', NOW(), NOW())`,
      [
        grantId,
        input.userId,
        input.source,
        input.grantedBy ?? null,
        input.amountCents,
        input.note ?? null,
        input.expiresAt ?? null,
      ],
    );

    const { rows: updatedRows } = await client.query(
      `UPDATE users
       SET bonus_cents = bonus_cents + $1
       WHERE id = $2
       RETURNING *`,
      [input.amountCents, input.userId],
    );

    await insertWalletTransaction(client, {
      userId: input.userId,
      kind: 'bonus_grant',
      amountCents: input.amountCents,
      balanceSource: 'bonus',
      balanceGrantId: grantId,
      note: input.note ?? `赠送余额（${input.source}）`,
      metadata: {
        source: input.source,
        grantedBy: input.grantedBy ?? null,
        expiresAt: input.expiresAt ?? null,
      },
    });

    await client.query('COMMIT');
    return {
      user: updatedRows[0] as User,
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
 * 定时任务入口：扫描已过期的活跃批次，批次级过期处理。
 * 每个批次在独立事务内完成：标记 expired → 扣 users.bonus_cents → 写流水。
 * FOR UPDATE SKIP LOCKED 保证多实例并发运行时不会重复处理同一批次。
 */
export async function expireBonusBalance(
  beforeIso: string,
  limit = 200,
): Promise<{ expired: number; totalCentsExpired: number }> {
  // 阶段 1：无锁快扫出候选批次（避免长事务）
  const { rows: candidates } = await pool.query(
    `SELECT id FROM balance_grants
     WHERE status = 'active'
       AND expires_at IS NOT NULL
       AND expires_at < $1
     ORDER BY expires_at ASC
     LIMIT $2`,
    [beforeIso, limit],
  );

  let expired = 0;
  let totalCentsExpired = 0;

  for (const { id: grantId } of candidates as { id: string }[]) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // SKIP LOCKED：并发实例遇到同一批次会直接跳过
      const { rows } = await client.query(
        `SELECT * FROM balance_grants
         WHERE id = $1
           AND status = 'active'
           AND expires_at IS NOT NULL
           AND expires_at < $2
         FOR UPDATE SKIP LOCKED`,
        [grantId, beforeIso],
      );
      const batch = rows[0] as BalanceGrantRow | undefined;
      if (!batch) {
        await client.query('COMMIT');
        continue;
      }

      const remaining = batch.remaining_cents;
      await client.query(
        `UPDATE balance_grants
         SET status = 'expired',
             remaining_cents = 0,
             updated_at = NOW()
         WHERE id = $1`,
        [batch.id],
      );

      if (remaining > 0) {
        await client.query(
          `UPDATE users
           SET bonus_cents = GREATEST(0, bonus_cents - $1)
           WHERE id = $2`,
          [remaining, batch.user_id],
        );

        await insertWalletTransaction(client, {
          userId: batch.user_id,
          kind: 'bonus_expire',
          amountCents: -remaining,
          balanceSource: 'bonus',
          balanceGrantId: batch.id,
          note: `赠送余额过期（批次 ${batch.id}）`,
          metadata: {
            batch_source: batch.source,
            expires_at: batch.expires_at,
            original_amount: batch.amount_cents,
          },
        });
      }

      await client.query('COMMIT');
      expired += 1;
      totalCentsExpired += remaining;
    } catch (err) {
      await client.query('ROLLBACK');
      logger.warn({ grantId, err }, '赠送余额过期处理失败');
    } finally {
      client.release();
    }
  }

  return { expired, totalCentsExpired };
}

export async function getBalanceGrantsByUserId(
  userId: string,
  opts?: { includeExhausted?: boolean; limit?: number },
): Promise<BalanceGrantRow[]> {
  const where: string[] = ['user_id = $1'];
  if (!opts?.includeExhausted) {
    where.push(`status = 'active'`);
  }
  const { rows } = await pool.query(
    `SELECT * FROM balance_grants
     WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, Math.min(opts?.limit ?? 50, 200)],
  );
  return rows as BalanceGrantRow[];
}

/**
 * 管理员调整用户的充值余额（purchased_cents）。
 * 负数时会被 reserved_cents 兜底拦截，避免把可用余额打成负。
 */
export async function adjustUserPurchasedBalance(
  userId: string,
  amountCents: number,
  note?: string | null,
): Promise<User> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await getUserByIdUsing(client, userId, {
      forUpdate: true,
    });
    if (!user) {
      throw new Error('用户不存在');
    }

    const nextPurchased = user.purchased_cents + amountCents;
    if (nextPurchased < 0) {
      throw new Error('余额不足，无法完成本次调整');
    }
    const spendable = nextPurchased + user.bonus_cents;
    if (spendable < user.reserved_cents) {
      throw new Error('可用余额不足以覆盖已预扣，无法完成调整');
    }

    const { rows: updatedRows } = await client.query(
      `UPDATE users
       SET purchased_cents = $1
       WHERE id = $2
       RETURNING *`,
      [nextPurchased, userId],
    );

    await insertWalletTransaction(client, {
      userId,
      kind: amountCents >= 0 ? 'manual_topup' : 'manual_adjustment',
      amountCents,
      balanceSource: 'purchased',
      note: note ?? null,
      metadata: { source: 'admin' },
    });

    await client.query('COMMIT');
    return updatedRows[0] as User;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 请求级预扣：锁定用户余额避免并发超额。
 * 可用余额（purchased + bonus - reserved）决定本次预扣上限。
 * 幂等：同一 requestId 已存在时直接返回现有预留。
 */
export async function reserveUserBalanceCents(input: {
  userId: string;
  amountCents: number;
  requestId: string;
  yearMonth: string;
  modelConfigId?: string | null;
  note?: string | null;
  metadata?: unknown;
}): Promise<{ user: User; reservedCents: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existingRows } = await client.query(
      'SELECT * FROM billing_request_reservations WHERE request_id = $1 FOR UPDATE',
      [input.requestId],
    );
    const existing = existingRows[0] as
      | BillingRequestReservationRow
      | undefined;
    if (existing) {
      const existingUser = await getUserByIdUsing(client, existing.user_id, {
        forUpdate: true,
      });
      if (!existingUser) {
        throw new Error('用户不存在');
      }
      await client.query('COMMIT');
      return {
        user: existingUser,
        reservedCents: existing.reserved_cents,
      };
    }

    const user = await getUserByIdUsing(client, input.userId, {
      forUpdate: true,
    });
    if (!user) {
      throw new Error('用户不存在');
    }

    const reservableHeadroom = calculateAvailableSpendableCents(user);
    if (input.amountCents > 0 && reservableHeadroom <= 0) {
      throw new Error('余额不足，请充值后继续使用');
    }

    const actualReservedCents = Math.min(
      Math.max(0, input.amountCents),
      reservableHeadroom,
    );
    const holdState: BillingRequestReservationRow['hold_state'] =
      actualReservedCents > 0 ? 'held' : 'none';

    const { rows: updatedRows } = await client.query(
      `UPDATE users
       SET reserved_cents = reserved_cents + $1
       WHERE id = $2
       RETURNING *`,
      [actualReservedCents, input.userId],
    );

    await insertBillingRequestReservation(client, {
      requestId: input.requestId,
      userId: input.userId,
      modelConfigId: input.modelConfigId ?? null,
      yearMonth: input.yearMonth,
      reservedCents: actualReservedCents,
      holdState,
      note: input.note ?? null,
      metadata: input.metadata,
    });

    await client.query('COMMIT');
    return {
      user: updatedRows[0] as User,
      reservedCents: actualReservedCents,
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: reservationRows } = await client.query(
      `SELECT * FROM billing_request_reservations
       WHERE request_id = $1
       FOR UPDATE`,
      [requestId],
    );
    const reservation = reservationRows[0] as
      | BillingRequestReservationRow
      | undefined;
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
      reservation.hold_state === 'held' ? reservation.reserved_cents : 0;
    const nextReservedCents = Math.max(0, user.reserved_cents - releasable);
    const { rows: updatedRows } = await client.query(
      `UPDATE users
       SET reserved_cents = $1
       WHERE id = $2
       RETURNING *`,
      [nextReservedCents, reservation.user_id],
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
    return updatedRows[0] as User;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function settleUserModelChargeCents(
  requestId: string,
  requestTokens: number,
  requestCostCents: number,
): Promise<{ actualChargeCents: number; user: User }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: reservationRows } = await client.query(
      `SELECT * FROM billing_request_reservations
       WHERE request_id = $1
       FOR UPDATE`,
      [requestId],
    );
    const reservation = reservationRows[0] as
      | BillingRequestReservationRow
      | undefined;
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
      await client.query('COMMIT');
      return {
        actualChargeCents: reservation.actual_charge_cents,
        user: existingUser,
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

    await client.query(
      `INSERT INTO monthly_billing_state
        (user_id, year_month, billed_overage_tokens, billed_overage_cost_cents, updated_at)
       VALUES ($1, $2, 0, 0, NOW())
       ON CONFLICT (user_id, year_month)
       DO UPDATE SET updated_at = monthly_billing_state.updated_at
       RETURNING *`,
      [reservation.user_id, reservation.year_month],
    );

    const actualChargeCents = Math.max(0, requestCostCents);
    const releasedReservedCents =
      reservation.hold_state === 'held' ? reservation.reserved_cents : 0;
    const nextReservedCents = Math.max(
      0,
      user.reserved_cents - releasedReservedCents,
    );

    // bonus → purchased 优先级扣减（内部更新 bonus_cents / purchased_cents）
    const deduction = await deductBalanceCents(client, user, actualChargeCents, {
      releasedReservedCents,
    });

    const { rows: updatedRows } = await client.query(
      `UPDATE users
       SET reserved_cents = $1
       WHERE id = $2
       RETURNING *`,
      [nextReservedCents, reservation.user_id],
    );

    await client.query(
      `UPDATE monthly_billing_state
       SET billed_overage_tokens = billed_overage_tokens + $1,
           billed_overage_cost_cents = billed_overage_cost_cents + $2,
           updated_at = NOW()
       WHERE user_id = $3 AND year_month = $4`,
      [
        requestTokens,
        actualChargeCents,
        reservation.user_id,
        reservation.year_month,
      ],
    );

    await client.query(
      `UPDATE billing_request_reservations
       SET hold_state = CASE WHEN hold_state = 'held' THEN 'released' ELSE hold_state END,
          charge_state = 'charged',
           actual_charge_cents = $2,
           total_overage_tokens = $3,
           total_overage_cost_cents = $4,
           released_at = CASE WHEN hold_state = 'held' THEN NOW() ELSE released_at END,
           charged_at = NOW(),
           updated_at = NOW()
       WHERE request_id = $1`,
      [requestId, actualChargeCents, requestTokens, actualChargeCents],
    );

    if (reservation.hold_state === 'held' && reservation.reserved_cents > 0) {
      await insertWalletTransaction(client, {
        userId: reservation.user_id,
        kind: 'reservation_release',
        reservedDeltaCents: -reservation.reserved_cents,
        requestId,
        note: '请求完成，释放预扣额度',
      });
    }

    if (actualChargeCents > 0) {
      await insertWalletTransaction(client, {
        userId: reservation.user_id,
        kind: 'overage_charge',
        amountCents: -actualChargeCents,
        balanceSource: deduction.balanceSource,
        requestId,
        note: '模型 Token 扣费',
        metadata: {
          yearMonth: reservation.year_month,
          requestTokens,
          requestCostCents,
          bonusDeducted: deduction.bonusDeducted,
          purchasedDeducted: deduction.purchasedDeducted,
          grantDeductions: deduction.grantDeductions,
        },
      });
    }

    await client.query('COMMIT');
    return {
      actualChargeCents,
      user: updatedRows[0] as User,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getMonthlyModelChargeCents(
  userId: string,
  yearMonth?: string,
): Promise<number> {
  const ym = yearMonth ?? new Date().toISOString().slice(0, 7);
  const { rows } = await pool.query(
    `SELECT COALESCE(billed_overage_cost_cents, 0) AS total
     FROM monthly_billing_state
     WHERE user_id = $1 AND year_month = $2`,
    [userId, ym],
  );
  return Number(
    (rows[0] as { total: string | number } | undefined)?.total ?? 0,
  );
}
