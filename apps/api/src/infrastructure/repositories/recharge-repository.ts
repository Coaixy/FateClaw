import { toCoins, insertWalletTransaction } from './wallet-repository.js';
import { getDbPool } from '#infrastructure/db-pool';

function normalizeRechargeOrderRow(row: RechargeOrderRow): RechargeOrderRow {
  return {
    ...row,
    amount_coins: toCoins(row.amount_coins),
  };
}

function normalizeAdminRechargeOrderRow(
  row: AdminRechargeOrderRow,
): AdminRechargeOrderRow {
  return {
    ...row,
    ...normalizeRechargeOrderRow(row),
    user_phone: row.user_phone ?? null,
  };
}

function normalizeRechargeStatsRow(row: RechargeStatsRow): RechargeStatsRow {
  return {
    ...row,
    total_recharge_coins: toCoins(row.total_recharge_coins),
  };
}

export type RechargePayType = 'alipay' | 'wechat';

export type RechargeOrderStatus = 'pending' | 'paid' | 'failed';

export interface RechargeOrderRow {
  id: string;
  user_id: string | null;
  trade_id: string;
  provider: 'epay' | string;
  provider_trade_id: string | null;
  pay_type: RechargePayType;
  amount_coins: number;
  pay_url: string | null;
  status: RechargeOrderStatus;
  credit_status: 'pending' | 'credited' | 'reconciliation_required';
  paid_at: string | null;
  notified_at: string | null;
  metadata: unknown;
  created_at: string;
  updated_at: string;
}

/** 管理后台充值订单列表行，附带用户手机号便于人工核对。 */
export interface AdminRechargeOrderRow extends RechargeOrderRow {
  user_phone: string | null;
}

/** 管理后台充值订单列表响应。 */
export interface AdminRechargeOrderListResult {
  orders: AdminRechargeOrderRow[];
  total: number;
}

export interface RechargeStatsRow {
  total_paid_orders: number;
  total_recharge_coins: number;
  last_paid_at: string | null;
}

export interface RechargePaymentConfigRow {
  id: 'default' | string;
  enabled: boolean;
  min_coins: string;
  max_coins: string;
  epay_url_prefix: string;
  epay_platform_id: number | null;
  epay_merchant_private_key: string;
  epay_platform_public_key: string;
  epay_merchant_key: string;
  notify_url: string;
  return_url: string;
  updated_at: string;
}

export async function getRechargePaymentConfig(): Promise<RechargePaymentConfigRow> {
  const { rows } = await getDbPool().query(
    `INSERT INTO recharge_payment_config (id)
     VALUES ('default')
     ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
     RETURNING *`,
  );
  return rows[0] as RechargePaymentConfigRow;
}

export async function updateRechargePaymentConfig(input: {
  enabled: boolean;
  minCoins: string;
  maxCoins: string;
  epayUrlPrefix: string;
  epayPlatformId: number | null;
  epayMerchantPrivateKey: string;
  epayPlatformPublicKey: string;
  epayMerchantKey: string;
  notifyUrl: string;
  returnUrl: string;
}): Promise<RechargePaymentConfigRow> {
  const { rows } = await getDbPool().query(
    `INSERT INTO recharge_payment_config (
       id, enabled, min_coins, max_coins, epay_url_prefix, epay_platform_id,
       epay_merchant_private_key, epay_platform_public_key, epay_merchant_key,
       notify_url, return_url, updated_at
     )
     VALUES ('default', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
     ON CONFLICT (id) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       min_coins = EXCLUDED.min_coins,
       max_coins = EXCLUDED.max_coins,
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
      input.minCoins,
      input.maxCoins,
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
  amountCoins: number;
  metadata?: unknown;
}): Promise<RechargeOrderRow> {
  const { rows } = await getDbPool().query(
    `INSERT INTO recharge_orders
       (id, user_id, trade_id, provider, pay_type, amount_coins,
        status, metadata, created_at, updated_at)
     VALUES ($1, $2, $3, 'epay', $4, $5, 'pending', $6, NOW(), NOW())
     RETURNING *`,
    [
      input.id,
      input.userId,
      input.tradeId,
      input.payType,
      input.amountCoins,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ],
  );
  return normalizeRechargeOrderRow(rows[0] as RechargeOrderRow);
}

export async function markRechargeOrderPaymentCreated(input: {
  tradeId: string;
  providerTradeId?: string | null;
  payUrl: string;
  metadata?: unknown;
}): Promise<RechargeOrderRow> {
  const { rows } = await getDbPool().query(
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
    throw new Error('补充积分订单不存在');
  }
  return normalizeRechargeOrderRow(rows[0] as RechargeOrderRow);
}

export async function markRechargeOrderFailed(
  tradeId: string,
  reason: string,
): Promise<void> {
  await getDbPool().query(
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
  const { rows } = await getDbPool().query(
    `SELECT * FROM recharge_orders WHERE trade_id = $1`,
    [tradeId],
  );
  const row = rows[0] as RechargeOrderRow | undefined;
  return row ? normalizeRechargeOrderRow(row) : undefined;
}

export async function getRechargeOrderByTradeIdForUser(
  userId: string,
  tradeId: string,
): Promise<RechargeOrderRow | undefined> {
  const { rows } = await getDbPool().query(
    `SELECT * FROM recharge_orders
     WHERE user_id = $1 AND trade_id = $2`,
    [userId, tradeId],
  );
  const row = rows[0] as RechargeOrderRow | undefined;
  return row ? normalizeRechargeOrderRow(row) : undefined;
}

export async function listRechargeOrdersByUserId(
  userId: string,
  limit = 20,
): Promise<RechargeOrderRow[]> {
  const { rows } = await getDbPool().query(
    `SELECT * FROM recharge_orders
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, Math.min(Math.max(limit, 1), 100)],
  );
  return (rows as RechargeOrderRow[]).map(normalizeRechargeOrderRow);
}

/**
 * 查询管理后台使用的全局充值订单列表。
 *
 * @param opts - 可按用户、订单状态和支付方式筛选，并支持分页。
 * @returns 订单列表与匹配总数；每行附带用户手机号。
 */
export async function listRechargeOrdersForAdmin(
  opts: {
    userId?: string;
    status?: RechargeOrderStatus;
    payType?: RechargePayType;
    limit?: number;
    offset?: number;
  } = {},
): Promise<AdminRechargeOrderListResult> {
  const where: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (opts.userId) {
    where.push(`ro.user_id = $${idx++}`);
    values.push(opts.userId);
  }
  if (opts.status) {
    where.push(`ro.status = $${idx++}`);
    values.push(opts.status);
  }
  if (opts.payType) {
    where.push(`ro.pay_type = $${idx++}`);
    values.push(opts.payType);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(opts.limit ?? 80, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  const { rows: countRows } = await getDbPool().query(
    `SELECT COUNT(*) AS cnt
     FROM recharge_orders ro
     ${whereClause}`,
    values,
  );

  const { rows } = await getDbPool().query(
    `SELECT ro.*, u.phone AS user_phone
     FROM recharge_orders ro
     LEFT JOIN users u ON u.id = ro.user_id
     ${whereClause}
     ORDER BY ro.created_at DESC
     LIMIT $${idx++} OFFSET $${idx++}`,
    [...values, limit, offset],
  );

  return {
    orders: (rows as AdminRechargeOrderRow[]).map(
      normalizeAdminRechargeOrderRow,
    ),
    total: Number((countRows[0] as { cnt: string }).cnt),
  };
}

export async function getRechargeStatsByUserId(
  userId: string,
): Promise<RechargeStatsRow> {
  const { rows } = await getDbPool().query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'paid')::int AS total_paid_orders,
       COALESCE(SUM(amount_coins) FILTER (WHERE status = 'paid'), 0)::float8
         AS total_recharge_coins,
       MAX(paid_at) FILTER (WHERE status = 'paid') AS last_paid_at
     FROM recharge_orders
     WHERE user_id = $1`,
    [userId],
  );
  return normalizeRechargeStatsRow(rows[0] as RechargeStatsRow);
}

export async function settleRechargeOrderPaid(input: {
  tradeId: string;
  providerTradeId?: string | null;
  payType?: RechargePayType | null;
  paidAt?: string | Date | null;
  notifyPayload?: unknown;
}): Promise<RechargeOrderRow> {
  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    // Lock the user before its order, matching deletion and recharge triggers.
    // Re-read the order after waiting: deletion may have detached it meanwhile.
    const owner = await client.query<{ user_id: string | null }>(
      'SELECT user_id FROM recharge_orders WHERE trade_id=$1',
      [input.tradeId],
    );
    if (owner.rows[0]?.user_id) {
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [
        owner.rows[0].user_id,
      ]);
    }
    const { rows: orderRows } = await client.query(
      `SELECT * FROM recharge_orders
       WHERE trade_id = $1
       FOR UPDATE`,
      [input.tradeId],
    );
    const order = orderRows[0]
      ? normalizeRechargeOrderRow(orderRows[0] as RechargeOrderRow)
      : undefined;
    if (!order) {
      throw new Error('补充积分订单不存在');
    }

    // 支付平台通知可能重复到达，已入账订单直接返回，保证幂等。
    if (order.status === 'paid') {
      await client.query('COMMIT');
      return normalizeRechargeOrderRow(order);
    }
    if (order.status !== 'pending') {
      throw new Error('充值单状态不可入账');
    }

    if (order.user_id !== null) {
      const credited = await client.query(
        `UPDATE users
       SET purchased_coins = purchased_coins + $1
       WHERE id = $2`,
        [order.amount_coins, order.user_id],
      );
      if (!credited.rowCount) throw new Error('充值用户不存在');

      await insertWalletTransaction(client, {
        userId: order.user_id,
        kind: 'recharge_topup',
        amountCoins: order.amount_coins,
        balanceSource: 'purchased',
        requestId: order.trade_id,
        note: `积分到账 ${order.amount_coins}`,
        metadata: {
          trade_id: order.trade_id,
          provider: order.provider,
          provider_trade_id: input.providerTradeId ?? order.provider_trade_id,
          pay_type: input.payType ?? order.pay_type,
        },
      });
    }

    const { rows: updatedRows } = await client.query(
      `UPDATE recharge_orders
       SET status = 'paid',
           credit_status = $6,
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
        order.user_id === null ? 'reconciliation_required' : 'credited',
      ],
    );

    await client.query('COMMIT');
    return normalizeRechargeOrderRow(updatedRows[0] as RechargeOrderRow);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
