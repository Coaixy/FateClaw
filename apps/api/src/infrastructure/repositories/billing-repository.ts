import crypto from 'node:crypto';
import pg from 'pg';

import { JWT_SECRET, WITHDRAWAL_ENCRYPTION_KEY } from '../config.js';
import { getDbPool } from '../db-pool.js';
import { logger } from '../logger.js';
import { getUserByIdUsing } from './users-repository.js';
import type { PointBatchSource, User } from '../../shared/types.js';
import {
  assertSufficientSpendablePoints,
  calculateAvailableSpendablePoints,
} from '../../shared/point-balance.js';

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
  amount_points: number;
  reserved_delta_points: number;
  point_source: 'purchased' | 'bonus' | 'earned' | 'mixed' | null;
  point_batch_id: string | null;
  request_id: string | null;
  note: string | null;
  metadata: unknown;
  created_at: string;
}

/**
 * 根据 wallet_transactions.kind 推断 point_source。
 * 调用方可覆写（如 overage_charge 的细化为 'bonus'/'purchased'/'mixed'）。
 */
function inferPointSourceFromKind(
  kind: string,
): 'purchased' | 'bonus' | 'earned' | 'mixed' | null {
  switch (kind) {
    case 'recharge_topup':
    case 'manual_topup':
    case 'manual_adjustment':
      return 'purchased';
    case 'creator_revenue':
      return 'earned';
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
  billed_overage_cost_points: number;
  updated_at: string;
}

export interface BillingRequestReservationRow {
  request_id: string;
  user_id: string;
  model_config_id: string | null;
  year_month: string;
  reserved_points: number;
  hold_state: 'none' | 'held' | 'released';
  charge_state: 'pending' | 'charged';
  actual_charge_points: number;
  total_overage_tokens: number;
  total_overage_cost_points: number;
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
  amount_points: number;
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
  total_recharge_points: number;
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

export async function insertWalletTransaction(
  client: pg.PoolClient,
  input: {
    userId: string;
    kind: string;
    amountPoints?: number;
    reservedDeltaPoints?: number;
    pointSource?: 'purchased' | 'bonus' | 'earned' | 'mixed' | null;
    pointBatchId?: string | null;
    requestId?: string | null;
    note?: string | null;
    metadata?: unknown;
  },
): Promise<void> {
  const amountPoints = input.amountPoints ?? 0;
  const reservedDeltaPoints = input.reservedDeltaPoints ?? 0;
  const pointSource =
    input.pointSource !== undefined
      ? input.pointSource
      : inferPointSourceFromKind(input.kind);

  // amount_cents / reserved_delta_cents 列仍存在（未 DROP），
  // 但不再由业务写入——DB DEFAULT 0 承接，直到 Stage 5 移除该列
  await client.query(
    `INSERT INTO wallet_transactions
      (id, user_id, kind,
       amount_points, reserved_delta_points, point_source, point_batch_id,
       request_id, note, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
    [
      `wtx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      input.userId,
      input.kind,
      amountPoints,
      reservedDeltaPoints,
      pointSource,
      input.pointBatchId ?? null,
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

export async function insertRechargeOrder(input: {
  id: string;
  userId: string;
  tradeId: string;
  payType: RechargePayType;
  amountYuan: string;
  amountPoints: number;
  metadata?: unknown;
}): Promise<RechargeOrderRow> {
  const { rows } = await pool.query(
    `INSERT INTO recharge_orders
       (id, user_id, trade_id, provider, pay_type, amount_yuan,
        amount_points, status, metadata, created_at, updated_at)
     VALUES ($1, $2, $3, 'epay', $4, $5, $6, 'pending', $7, NOW(), NOW())
     RETURNING *`,
    [
      input.id,
      input.userId,
      input.tradeId,
      input.payType,
      input.amountYuan,
      input.amountPoints,
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
       COALESCE(SUM(amount_points) FILTER (WHERE status = 'paid'), 0)::int
         AS total_recharge_points,
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
       SET purchased_points = purchased_points + $1
       WHERE id = $2`,
      [order.amount_points, order.user_id],
    );

    await insertWalletTransaction(client, {
      userId: order.user_id,
      kind: 'recharge_topup',
      amountPoints: order.amount_points,
      pointSource: 'purchased',
      requestId: order.trade_id,
      note: `充值到账 ¥${order.amount_yuan}`,
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
    reservedPoints: number;
    holdState: BillingRequestReservationRow['hold_state'];
    note?: string | null;
    metadata?: unknown;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO billing_request_reservations
      (request_id, user_id, model_config_id, year_month, reserved_points,
       hold_state, charge_state, note, metadata, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, NOW(), NOW())
     ON CONFLICT (request_id) DO NOTHING`,
    [
      input.requestId,
      input.userId,
      input.modelConfigId ?? null,
      input.yearMonth,
      input.reservedPoints,
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
      await releaseUserReservation(row.request_id, '陈旧预留自动释放', {
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
       AND amount_points <> 0
       AND kind <> 'overage_charge'
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit],
  );
  return rows as WalletTransactionRow[];
}

// =====================
// --- Point batches / 积分扣减算法 ---
// =====================

export interface PointBatchRow {
  id: string;
  user_id: string;
  source: string;
  granted_by: string | null;
  amount_points: number;
  remaining_points: number;
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
): Promise<PointBatchRow[]> {
  const { rows } = await client.query(
    `SELECT * FROM point_batches
     WHERE user_id = $1
       AND status = 'active'
       AND remaining_points > 0
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY expires_at ASC NULLS LAST, created_at ASC
     FOR UPDATE`,
    [userId],
  );
  return rows as PointBatchRow[];
}

export interface DeductPointsResult {
  bonusDeducted: number;
  purchasedDeducted: number;
  batchDeductions: Array<{ batchId: string; points: number }>;
  pointSource: 'purchased' | 'bonus' | 'mixed' | null;
}

/**
 * 内部扣减算法：在一次事务中按 bonus → purchased 顺序扣减积分，
 * 并维护 point_batches.remaining_points / users.{bonus_points,purchased_points}。
 * 返回的 pointSource 会作为 wallet_transactions.point_source 写入流水。
 */
export async function deductPoints(
  client: pg.PoolClient,
  user: User,
  chargePoints: number,
  options?: { releasedReservedPoints?: number },
): Promise<DeductPointsResult> {
  if (chargePoints <= 0) {
    return {
      bonusDeducted: 0,
      purchasedDeducted: 0,
      batchDeductions: [],
      pointSource: null,
    };
  }
  assertSufficientSpendablePoints(user, chargePoints, options);

  let bonusLeft = chargePoints;
  const batchDeductions: Array<{ batchId: string; points: number }> = [];

  const batches = await getAvailableBonusBatches(client, user.id);
  for (const batch of batches) {
    if (bonusLeft <= 0) break;
    const toDeduct = Math.min(batch.remaining_points, bonusLeft);
    if (toDeduct <= 0) continue;
    await client.query(
      `UPDATE point_batches
       SET remaining_points = remaining_points - $1,
           status = CASE WHEN remaining_points - $1 <= 0 THEN 'exhausted' ELSE status END,
           updated_at = NOW()
       WHERE id = $2`,
      [toDeduct, batch.id],
    );
    batchDeductions.push({ batchId: batch.id, points: toDeduct });
    bonusLeft -= toDeduct;
  }

  const bonusDeducted = chargePoints - bonusLeft;
  const purchasedDeducted = bonusLeft;
  if (
    user.bonus_points < bonusDeducted ||
    user.purchased_points < purchasedDeducted
  ) {
    throw new Error('余额不足，请充值后继续使用');
  }

  // 更新 users 表的桶字段
  await client.query(
    `UPDATE users
     SET bonus_points = bonus_points - $1,
         purchased_points = purchased_points - $2
     WHERE id = $3`,
    [bonusDeducted, purchasedDeducted, user.id],
  );

  let pointSource: DeductPointsResult['pointSource'];
  if (bonusDeducted > 0 && purchasedDeducted > 0) pointSource = 'mixed';
  else if (bonusDeducted > 0) pointSource = 'bonus';
  else if (purchasedDeducted > 0) pointSource = 'purchased';
  else pointSource = null;

  return {
    bonusDeducted,
    purchasedDeducted,
    batchDeductions,
    pointSource,
  };
}

/**
 * 赠送积分（新用户礼包、签到奖励、活动积分、管理员手动发放）。
 * 原子操作：创建 point_batches 行 → 更新 users.bonus_points → 写流水。
 */
export async function grantBonusPoints(input: {
  userId: string;
  source: PointBatchSource | string;
  amountPoints: number;
  expiresAt?: string | null;
  note?: string | null;
  grantedBy?: string | null;
}): Promise<{ user: User; batchId: string }> {
  if (input.amountPoints <= 0) {
    throw new Error('赠送积分数量必须为正');
  }
  const batchId = `pb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await getUserByIdUsing(client, input.userId, {
      forUpdate: true,
    });
    if (!user) throw new Error('用户不存在');

    await client.query(
      `INSERT INTO point_batches
         (id, user_id, source, granted_by, amount_points, remaining_points,
          note, expires_at, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5, $6, $7, 'active', NOW(), NOW())`,
      [
        batchId,
        input.userId,
        input.source,
        input.grantedBy ?? null,
        input.amountPoints,
        input.note ?? null,
        input.expiresAt ?? null,
      ],
    );

    const { rows: updatedRows } = await client.query(
      `UPDATE users
       SET bonus_points = bonus_points + $1
       WHERE id = $2
       RETURNING *`,
      [input.amountPoints, input.userId],
    );

    await insertWalletTransaction(client, {
      userId: input.userId,
      kind: 'bonus_grant',
      amountPoints: input.amountPoints,
      pointSource: 'bonus',
      pointBatchId: batchId,
      note: input.note ?? `赠送积分（${input.source}）`,
      metadata: {
        source: input.source,
        grantedBy: input.grantedBy ?? null,
        expiresAt: input.expiresAt ?? null,
      },
    });

    await client.query('COMMIT');
    return {
      user: updatedRows[0] as User,
      batchId,
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
 * 每个批次在独立事务内完成：标记 expired → 扣 users.bonus_points → 写流水。
 * FOR UPDATE SKIP LOCKED 保证多实例并发运行时不会重复处理同一批次。
 */
export async function expireBonusPoints(
  beforeIso: string,
  limit = 200,
): Promise<{ expired: number; totalPointsExpired: number }> {
  // 阶段 1：无锁快扫出候选批次（避免长事务）
  const { rows: candidates } = await pool.query(
    `SELECT id FROM point_batches
     WHERE status = 'active'
       AND expires_at IS NOT NULL
       AND expires_at < $1
     ORDER BY expires_at ASC
     LIMIT $2`,
    [beforeIso, limit],
  );

  let expired = 0;
  let totalPointsExpired = 0;

  for (const { id: batchId } of candidates as { id: string }[]) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // SKIP LOCKED：并发实例遇到同一批次会直接跳过
      const { rows } = await client.query(
        `SELECT * FROM point_batches
         WHERE id = $1
           AND status = 'active'
           AND expires_at IS NOT NULL
           AND expires_at < $2
         FOR UPDATE SKIP LOCKED`,
        [batchId, beforeIso],
      );
      const batch = rows[0] as PointBatchRow | undefined;
      if (!batch) {
        await client.query('COMMIT');
        continue;
      }

      const remaining = batch.remaining_points;
      await client.query(
        `UPDATE point_batches
         SET status = 'expired',
             remaining_points = 0,
             updated_at = NOW()
         WHERE id = $1`,
        [batch.id],
      );

      if (remaining > 0) {
        await client.query(
          `UPDATE users
           SET bonus_points = GREATEST(0, bonus_points - $1)
           WHERE id = $2`,
          [remaining, batch.user_id],
        );

        await insertWalletTransaction(client, {
          userId: batch.user_id,
          kind: 'bonus_expire',
          amountPoints: -remaining,
          pointSource: 'bonus',
          pointBatchId: batch.id,
          note: `赠送积分过期（批次 ${batch.id}）`,
          metadata: {
            batch_source: batch.source,
            expires_at: batch.expires_at,
            original_amount: batch.amount_points,
          },
        });
      }

      await client.query('COMMIT');
      expired += 1;
      totalPointsExpired += remaining;
    } catch (err) {
      await client.query('ROLLBACK');
      logger.warn({ batchId, err }, '赠送积分过期处理失败');
    } finally {
      client.release();
    }
  }

  return { expired, totalPointsExpired };
}

export async function getPointBatchesByUserId(
  userId: string,
  opts?: { includeExhausted?: boolean; limit?: number },
): Promise<PointBatchRow[]> {
  const where: string[] = ['user_id = $1'];
  if (!opts?.includeExhausted) {
    where.push(`status = 'active'`);
  }
  const { rows } = await pool.query(
    `SELECT * FROM point_batches
     WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, Math.min(opts?.limit ?? 50, 200)],
  );
  return rows as PointBatchRow[];
}

// =====================
// --- Creator withdrawals / 创作者提现通道 ---
// =====================

/**
 * 派生 AES-GCM 加密密钥。配置了 WITHDRAWAL_ENCRYPTION_KEY 时使用该值（hex 64 字符），
 * 未配置时用 JWT_SECRET 派生（仅开发环境兜底，生产必须显式配置）。
 */
function getWithdrawalCipherKey(): Buffer {
  if (WITHDRAWAL_ENCRYPTION_KEY && WITHDRAWAL_ENCRYPTION_KEY.length >= 64) {
    return Buffer.from(WITHDRAWAL_ENCRYPTION_KEY.slice(0, 64), 'hex');
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '生产环境必须配置 WITHDRAWAL_ENCRYPTION_KEY（64 字符 hex，可用 `openssl rand -hex 32` 生成）',
    );
  }
  // 开发/测试环境：从 JWT_SECRET 派生（SHA-256 取前 32 字节），一次性警告
  if (!derivedKeyWarned) {
    logger.warn(
      '未配置 WITHDRAWAL_ENCRYPTION_KEY，开发环境使用 JWT_SECRET 派生兜底密钥',
    );
    derivedKeyWarned = true;
  }
  return crypto.createHash('sha256').update(JWT_SECRET).digest();
}
let derivedKeyWarned = false;

/** AES-256-GCM 加密。输出格式：base64(iv[12] || ciphertext || authTag[16]) */
export function encryptSensitive(plaintext: string): string {
  if (!plaintext) return '';
  const key = getWithdrawalCipherKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, enc, tag]).toString('base64');
}

export function decryptSensitive(encoded: string | null | undefined): string {
  if (!encoded) return '';
  const buf = Buffer.from(encoded, 'base64');
  if (buf.length < 12 + 16) throw new Error('密文格式错误');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ciphertext = buf.subarray(12, buf.length - 16);
  const key = getWithdrawalCipherKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return dec.toString('utf8');
}

/** 脱敏显示身份证号：只保留前 4 位和后 4 位 */
export function maskIdNumber(id: string): string {
  if (!id) return '';
  if (id.length <= 8) return '*'.repeat(id.length);
  return `${id.slice(0, 4)}${'*'.repeat(id.length - 8)}${id.slice(-4)}`;
}

export interface CreatorWithdrawalRow {
  id: string;
  creator_id: string;
  amount_points: number;
  amount_yuan: string; // NUMERIC as string
  status: 'pending' | 'approved' | 'rejected' | 'paid' | 'cancelled';
  bank_name: string | null;
  bank_account: string | null;
  account_name: string | null;
  id_number: string | null; // AES-GCM 密文 (base64)
  tax_type: 'personal' | 'company' | null;
  company_name: string | null;
  tax_id: string | null;
  platform_fee_points: number;
  tax_amount_yuan: string;
  net_amount_yuan: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  paid_at: string | null;
  payment_proof: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * 创作者发起提现申请。冻结 pending_withdrawal_points（不动 earned_points）。
 * 校验：amount_points > 0 且 earned_points - pending_withdrawal_points >= amount_points。
 */
export async function createWithdrawalRequest(input: {
  creatorId: string;
  amountPoints: number;
  bankName?: string | null;
  bankAccount?: string | null;
  accountName?: string | null;
  idNumber?: string | null; // 明文传入，函数内部加密
  taxType?: 'personal' | 'company' | null;
  companyName?: string | null;
  taxId?: string | null;
}): Promise<CreatorWithdrawalRow> {
  if (input.amountPoints <= 0) {
    throw new Error('提现积分必须为正');
  }
  const withdrawalId = `wd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await getUserByIdUsing(client, input.creatorId, {
      forUpdate: true,
    });
    if (!user) throw new Error('用户不存在');

    const withdrawable = user.earned_points - user.pending_withdrawal_points;
    if (withdrawable < input.amountPoints) {
      throw new Error(
        `可提现积分不足：可用 ${withdrawable}，申请 ${input.amountPoints}`,
      );
    }

    // 100 积分 = 1 元
    const amountYuan = (input.amountPoints / 100).toFixed(2);

    await client.query(
      `UPDATE users
       SET pending_withdrawal_points = pending_withdrawal_points + $1
       WHERE id = $2`,
      [input.amountPoints, input.creatorId],
    );

    const idNumberEncrypted = input.idNumber
      ? encryptSensitive(input.idNumber)
      : null;

    const { rows } = await client.query(
      `INSERT INTO creator_withdrawals
        (id, creator_id, amount_points, amount_yuan, status,
         bank_name, bank_account, account_name, id_number,
         tax_type, company_name, tax_id,
         platform_fee_points, tax_amount_yuan, net_amount_yuan,
         created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'pending',
               $5, $6, $7, $8,
               $9, $10, $11,
               0, 0, $4,
               NOW(), NOW())
       RETURNING *`,
      [
        withdrawalId,
        input.creatorId,
        input.amountPoints,
        amountYuan,
        input.bankName ?? null,
        input.bankAccount ?? null,
        input.accountName ?? null,
        idNumberEncrypted,
        input.taxType ?? null,
        input.companyName ?? null,
        input.taxId ?? null,
      ],
    );

    await client.query('COMMIT');
    return rows[0] as CreatorWithdrawalRow;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getWithdrawalById(
  id: string,
): Promise<CreatorWithdrawalRow | undefined> {
  const { rows } = await pool.query(
    'SELECT * FROM creator_withdrawals WHERE id = $1',
    [id],
  );
  return rows[0] as CreatorWithdrawalRow | undefined;
}

export async function listWithdrawalsForCreator(
  creatorId: string,
  limit = 50,
): Promise<CreatorWithdrawalRow[]> {
  const { rows } = await pool.query(
    `SELECT * FROM creator_withdrawals
     WHERE creator_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [creatorId, Math.min(limit, 200)],
  );
  return rows as CreatorWithdrawalRow[];
}

export async function listAllWithdrawals(opts?: {
  status?: CreatorWithdrawalRow['status'];
  creatorId?: string;
  limit?: number;
}): Promise<CreatorWithdrawalRow[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (opts?.status) {
    where.push(`status = $${idx++}`);
    values.push(opts.status);
  }
  if (opts?.creatorId) {
    where.push(`creator_id = $${idx++}`);
    values.push(opts.creatorId);
  }
  values.push(Math.min(opts?.limit ?? 50, 200));
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM creator_withdrawals
     ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${idx}`,
    values,
  );
  return rows as CreatorWithdrawalRow[];
}

/**
 * 审核通过：从 earned_points 正式扣减、释放 pending、写 creator_earnings_monthly.withdrawn_points + 流水。
 * taxAmountYuan / netAmountYuan / platformFeePoints 由管理员审核时决定。
 */
export async function approveWithdrawal(input: {
  withdrawalId: string;
  reviewedBy: string;
  taxAmountYuan?: string;
  netAmountYuan?: string;
  platformFeePoints?: number;
  note?: string | null;
}): Promise<CreatorWithdrawalRow> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: wdRows } = await client.query(
      'SELECT * FROM creator_withdrawals WHERE id = $1 FOR UPDATE',
      [input.withdrawalId],
    );
    const wd = wdRows[0] as CreatorWithdrawalRow | undefined;
    if (!wd) throw new Error('提现申请不存在');
    if (wd.status !== 'pending') {
      throw new Error(`当前状态 ${wd.status} 无法审核通过`);
    }

    const user = await getUserByIdUsing(client, wd.creator_id, {
      forUpdate: true,
    });
    if (!user) throw new Error('创作者不存在');
    if (user.earned_points < wd.amount_points) {
      throw new Error('创作者可提现积分不足（earned_points 异常）');
    }

    await client.query(
      `UPDATE users
       SET earned_points = earned_points - $1,
           pending_withdrawal_points = GREATEST(0, pending_withdrawal_points - $1)
       WHERE id = $2`,
      [wd.amount_points, wd.creator_id],
    );

    const taxAmountYuan = input.taxAmountYuan ?? '0';
    const netAmountYuan = input.netAmountYuan ?? wd.amount_yuan;
    const platformFeePoints = input.platformFeePoints ?? 0;

    const { rows: updatedRows } = await client.query(
      `UPDATE creator_withdrawals
       SET status = 'approved',
           reviewed_by = $1,
           reviewed_at = NOW(),
           review_note = $2,
           tax_amount_yuan = $3,
           net_amount_yuan = $4,
           platform_fee_points = $5,
           updated_at = NOW()
       WHERE id = $6
       RETURNING *`,
      [
        input.reviewedBy,
        input.note ?? null,
        taxAmountYuan,
        netAmountYuan,
        platformFeePoints,
        input.withdrawalId,
      ],
    );

    // 更新当月 creator_earnings_monthly.withdrawn_points
    const yearMonth = new Date().toISOString().slice(0, 7);
    await client.query(
      `INSERT INTO creator_earnings_monthly
         (creator_id, year_month,
          gross_points, platform_cut_points, net_points, withdrawn_points,
          updated_at)
       VALUES ($1, $2, 0, 0, 0, $3, NOW())
       ON CONFLICT (creator_id, year_month) DO UPDATE SET
         withdrawn_points = creator_earnings_monthly.withdrawn_points + EXCLUDED.withdrawn_points,
         updated_at = NOW()`,
      [wd.creator_id, yearMonth, wd.amount_points],
    );

    await insertWalletTransaction(client, {
      userId: wd.creator_id,
      kind: 'withdrawal',
      amountPoints: -wd.amount_points,
      pointSource: 'earned',
      note: `提现申请批准：${wd.amount_yuan} 元`,
      metadata: {
        withdrawal_id: wd.id,
        tax_amount_yuan: taxAmountYuan,
        net_amount_yuan: netAmountYuan,
        platform_fee_points: platformFeePoints,
      },
    });

    await client.query('COMMIT');
    return updatedRows[0] as CreatorWithdrawalRow;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function rejectWithdrawal(input: {
  withdrawalId: string;
  reviewedBy: string;
  note: string;
}): Promise<CreatorWithdrawalRow> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: wdRows } = await client.query(
      'SELECT * FROM creator_withdrawals WHERE id = $1 FOR UPDATE',
      [input.withdrawalId],
    );
    const wd = wdRows[0] as CreatorWithdrawalRow | undefined;
    if (!wd) throw new Error('提现申请不存在');
    if (wd.status !== 'pending') {
      throw new Error(`当前状态 ${wd.status} 无法驳回`);
    }

    // 解冻 pending_withdrawal_points
    await client.query(
      `UPDATE users
       SET pending_withdrawal_points = GREATEST(0, pending_withdrawal_points - $1)
       WHERE id = $2`,
      [wd.amount_points, wd.creator_id],
    );

    const { rows: updatedRows } = await client.query(
      `UPDATE creator_withdrawals
       SET status = 'rejected',
           reviewed_by = $1,
           reviewed_at = NOW(),
           review_note = $2,
           updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [input.reviewedBy, input.note, input.withdrawalId],
    );

    await client.query('COMMIT');
    return updatedRows[0] as CreatorWithdrawalRow;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function markWithdrawalPaid(input: {
  withdrawalId: string;
  paymentProof: string;
}): Promise<CreatorWithdrawalRow> {
  const { rows } = await pool.query(
    `UPDATE creator_withdrawals
     SET status = 'paid',
         paid_at = NOW(),
         payment_proof = $1,
         updated_at = NOW()
     WHERE id = $2 AND status = 'approved'
     RETURNING *`,
    [input.paymentProof, input.withdrawalId],
  );
  if (rows.length === 0) {
    throw new Error('提现申请不存在或状态不是已批准');
  }
  return rows[0] as CreatorWithdrawalRow;
}

/**
 * 管理员调整用户的充值积分（purchased_points）。
 * 负数时会被 reserved_points 兜底拦截，避免把可用积分打成负。
 */
export async function adjustUserPurchasedPoints(
  userId: string,
  amountPoints: number,
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

    const nextPurchased = user.purchased_points + amountPoints;
    if (nextPurchased < 0) {
      throw new Error('积分不足，无法完成本次调整');
    }
    const spendable = nextPurchased + user.bonus_points;
    if (spendable < user.reserved_points) {
      throw new Error('可用积分不足以覆盖已预扣，无法完成调整');
    }

    const { rows: updatedRows } = await client.query(
      `UPDATE users
       SET purchased_points = $1
       WHERE id = $2
       RETURNING *`,
      [nextPurchased, userId],
    );

    await insertWalletTransaction(client, {
      userId,
      kind: amountPoints >= 0 ? 'manual_topup' : 'manual_adjustment',
      amountPoints,
      pointSource: 'purchased',
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
 * 请求级预扣：锁定用户积分避免并发超额。
 * 可用积分（purchased + bonus - reserved）决定本次预扣上限。
 * 幂等：同一 requestId 已存在时直接返回现有预留。
 */
export async function reserveUserPoints(input: {
  userId: string;
  amountPoints: number;
  requestId: string;
  yearMonth: string;
  modelConfigId?: string | null;
  note?: string | null;
  metadata?: unknown;
}): Promise<{ user: User; reservedPoints: number }> {
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
        reservedPoints: existing.reserved_points,
      };
    }

    const user = await getUserByIdUsing(client, input.userId, {
      forUpdate: true,
    });
    if (!user) {
      throw new Error('用户不存在');
    }

    const reservableHeadroom = calculateAvailableSpendablePoints(user);
    if (input.amountPoints > 0 && reservableHeadroom <= 0) {
      throw new Error('余额不足，请充值后继续使用');
    }

    const actualReservedPoints = Math.min(
      Math.max(0, input.amountPoints),
      reservableHeadroom,
    );
    const holdState: BillingRequestReservationRow['hold_state'] =
      actualReservedPoints > 0 ? 'held' : 'none';

    const { rows: updatedRows } = await client.query(
      `UPDATE users
       SET reserved_points = reserved_points + $1
       WHERE id = $2
       RETURNING *`,
      [actualReservedPoints, input.userId],
    );

    await insertBillingRequestReservation(client, {
      requestId: input.requestId,
      userId: input.userId,
      modelConfigId: input.modelConfigId ?? null,
      yearMonth: input.yearMonth,
      reservedPoints: actualReservedPoints,
      holdState,
      note: input.note ?? null,
      metadata: input.metadata,
    });

    await client.query('COMMIT');
    return {
      user: updatedRows[0] as User,
      reservedPoints: actualReservedPoints,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function releaseUserReservation(
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
      reservation.hold_state === 'held' ? reservation.reserved_points : 0;
    const nextReservedPoints = Math.max(0, user.reserved_points - releasable);
    const { rows: updatedRows } = await client.query(
      `UPDATE users
       SET reserved_points = $1
       WHERE id = $2
       RETURNING *`,
      [nextReservedPoints, reservation.user_id],
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

export async function settleUserModelChargePoints(
  requestId: string,
  requestTokens: number,
  requestCostPoints: number,
): Promise<{ actualChargePoints: number; user: User }> {
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
        actualChargePoints: reservation.actual_charge_points,
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
        (user_id, year_month, billed_overage_tokens, billed_overage_cost_points, updated_at)
       VALUES ($1, $2, 0, 0, NOW())
       ON CONFLICT (user_id, year_month)
       DO UPDATE SET updated_at = monthly_billing_state.updated_at
       RETURNING *`,
      [reservation.user_id, reservation.year_month],
    );

    const actualChargePoints = Math.max(0, requestCostPoints);
    const releasedReservedPoints =
      reservation.hold_state === 'held' ? reservation.reserved_points : 0;
    const nextReservedPoints = Math.max(
      0,
      user.reserved_points - releasedReservedPoints,
    );

    // bonus → purchased 优先级扣减（内部更新 bonus_points / purchased_points）
    const deduction = await deductPoints(client, user, actualChargePoints, {
      releasedReservedPoints,
    });

    const { rows: updatedRows } = await client.query(
      `UPDATE users
       SET reserved_points = $1
       WHERE id = $2
       RETURNING *`,
      [nextReservedPoints, reservation.user_id],
    );

    await client.query(
      `UPDATE monthly_billing_state
       SET billed_overage_tokens = billed_overage_tokens + $1,
           billed_overage_cost_points = billed_overage_cost_points + $2,
           updated_at = NOW()
       WHERE user_id = $3 AND year_month = $4`,
      [
        requestTokens,
        actualChargePoints,
        reservation.user_id,
        reservation.year_month,
      ],
    );

    await client.query(
      `UPDATE billing_request_reservations
       SET hold_state = CASE WHEN hold_state = 'held' THEN 'released' ELSE hold_state END,
          charge_state = 'charged',
           actual_charge_points = $2,
           total_overage_tokens = $3,
           total_overage_cost_points = $4,
           released_at = CASE WHEN hold_state = 'held' THEN NOW() ELSE released_at END,
           charged_at = NOW(),
           updated_at = NOW()
       WHERE request_id = $1`,
      [requestId, actualChargePoints, requestTokens, actualChargePoints],
    );

    if (reservation.hold_state === 'held' && reservation.reserved_points > 0) {
      await insertWalletTransaction(client, {
        userId: reservation.user_id,
        kind: 'reservation_release',
        reservedDeltaPoints: -reservation.reserved_points,
        requestId,
        note: '请求完成，释放预扣额度',
      });
    }

    if (actualChargePoints > 0) {
      await insertWalletTransaction(client, {
        userId: reservation.user_id,
        kind: 'overage_charge',
        amountPoints: -actualChargePoints,
        pointSource: deduction.pointSource,
        requestId,
        note: '官方模型 Token 扣费',
        metadata: {
          yearMonth: reservation.year_month,
          requestTokens,
          requestCostPoints,
          bonusDeducted: deduction.bonusDeducted,
          purchasedDeducted: deduction.purchasedDeducted,
          batchDeductions: deduction.batchDeductions,
        },
      });
    }

    await client.query('COMMIT');
    return {
      actualChargePoints,
      user: updatedRows[0] as User,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getMonthlyModelChargePoints(
  userId: string,
  yearMonth?: string,
): Promise<number> {
  const ym = yearMonth ?? new Date().toISOString().slice(0, 7);
  const { rows } = await pool.query(
    `SELECT COALESCE(billed_overage_cost_points, 0) AS total
     FROM monthly_billing_state
     WHERE user_id = $1 AND year_month = $2`,
    [userId, ym],
  );
  return Number(
    (rows[0] as { total: string | number } | undefined)?.total ?? 0,
  );
}
