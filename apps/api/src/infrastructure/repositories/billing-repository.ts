import pg from 'pg';

import { getDbPool } from '../db-pool.js';
import { logger } from '../logger.js';
import { MAX_OVERDRAFT_COINS } from '../config.js';
import { getUserByIdUsing } from './users-repository.js';
import type {
  BalanceGrantSource,
  MembershipConfig,
  User,
  UserMembership,
} from '../../shared/types.js';
import {
  assertSufficientSpendableCoins,
  roundCoinsToCents,
} from '../../shared/balance-coins.js';
import { resolveMembershipPeriodStart } from '../../shared/membership-cycle.js';
import {
  DEFAULT_MEMBERSHIP_NAME,
  MEMBERSHIP_PLAN_KEY,
  type MembershipPlanKey,
} from '@fateclaw/contracts/membership';

const pool = {
  query(sql: string, params?: unknown[]) {
    return getDbPool().query(sql, params);
  },
  connect() {
    return getDbPool().connect();
  },
};

function toCoins(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function addMonths(date: Date, months: number): Date {
  const next = new Date(date);
  const originalDate = next.getUTCDate();
  // 先落到月初再切月，避免月底日期被 JS Date 自动溢出到下下个月。
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + months);
  const lastDayOfTargetMonth = new Date(
    Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
  ).getUTCDate();
  next.setUTCDate(Math.min(originalDate, lastDayOfTargetMonth));
  return next;
}

function normalizeUserCoins(row: User): User {
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

function numberFromMetadata(
  metadata: unknown,
  key: string,
): number | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const value = (metadata as Record<string, unknown>)[key];
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

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

function normalizeBalanceGrantRow(row: BalanceGrantRow): BalanceGrantRow {
  return {
    ...row,
    amount_coins: toCoins(row.amount_coins),
    remaining_coins: toCoins(row.remaining_coins),
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

function normalizeMembershipConfigRow(row: MembershipConfig): MembershipConfig {
  const monthlyPriceCoins = toCoins(row.monthly_price_coins);
  return {
    ...row,
    name: row.name || DEFAULT_MEMBERSHIP_NAME,
    monthly_price_coins: monthlyPriceCoins,
    display_price_coins: Math.max(
      monthlyPriceCoins,
      toCoins(row.display_price_coins),
    ),
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

export type RechargePayType = 'alipay' | 'wechat';
export type RechargeOrderStatus = 'pending' | 'paid' | 'failed';

export interface RechargeOrderRow {
  id: string;
  user_id: string;
  trade_id: string;
  provider: 'epay' | string;
  provider_trade_id: string | null;
  pay_type: RechargePayType;
  amount_coins: number;
  pay_url: string | null;
  status: RechargeOrderStatus;
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

export type MembershipConfigRow = MembershipConfig;
export type UserMembershipRow = UserMembership;

export interface MembershipOverviewRow {
  config: MembershipConfigRow;
  membership: UserMembershipRow | null;
  active: boolean;
}

/** Membership periods exposed by the billing API. */
export interface MembershipEntitlementRow {
  plan_key: MembershipPlanKey;
  name: string;
  effective_start: string;
  effective_end: string;
  is_current: boolean;
}

async function getMembershipConfigUsing(input: {
  query(sql: string, params?: unknown[]): Promise<pg.QueryResult>;
}): Promise<MembershipConfigRow> {
  // Existing installations retain their configured price, name and sale status.
  const { rows } = await input.query(
    `INSERT INTO membership_config (
       id, name, monthly_price_coins, display_price_coins
     )
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
     RETURNING *`,
    [MEMBERSHIP_PLAN_KEY, DEFAULT_MEMBERSHIP_NAME, 10, 10],
  );
  return normalizeMembershipConfigRow(rows[0] as MembershipConfigRow);
}

export async function getMembershipConfig(): Promise<MembershipConfigRow> {
  return getMembershipConfigUsing({ query: pool.query });
}

export async function getMembershipPlanConfigs(): Promise<
  MembershipConfigRow[]
> {
  const config = await getMembershipConfig();
  return config.enabled ? [config] : [];
}

/**
 * 更新指定会员套餐的可配置字段（价格 / 名称 / 启用状态）。
 *
 * 仅 UPDATE 既有行（不 INSERT），调用前应确保该行已 ensure（getMembershipConfig 会补齐）。
 * 动态拼接 SET，只更新传入字段，未传字段保持原值。
 *
 * @param input.id The membership configuration ID.
 * @param input.monthlyPriceCoins 月费积分，可选。
 * @param input.displayPriceCoins 展示价积分，可选。
 * @param input.name 套餐名称，可选。
 * @param input.enabled 是否启用，可选。
 * @returns 更新后的套餐行；套餐不存在时返回 undefined。
 */
export async function updateMembershipConfig(input: {
  id: MembershipPlanKey;
  monthlyPriceCoins?: number;
  displayPriceCoins?: number;
  name?: string;
  enabled?: boolean;
}): Promise<MembershipConfigRow | undefined> {
  const sets: string[] = ['updated_at = NOW()'];
  const values: unknown[] = [];
  let idx = 1;

  if (input.monthlyPriceCoins !== undefined) {
    sets.push(`monthly_price_coins = $${idx++}`);
    values.push(input.monthlyPriceCoins);
  }
  if (input.displayPriceCoins !== undefined) {
    sets.push(`display_price_coins = $${idx++}`);
    values.push(input.displayPriceCoins);
  }
  if (input.name !== undefined) {
    sets.push(`name = $${idx++}`);
    values.push(input.name);
  }
  if (input.enabled !== undefined) {
    sets.push(`enabled = $${idx++}`);
    values.push(input.enabled);
  }

  values.push(input.id);
  const { rows } = await pool.query(
    `UPDATE membership_config
     SET ${sets.join(', ')}
     WHERE id = $${idx}
     RETURNING *`,
    values,
  );
  const row = rows[0] as MembershipConfigRow | undefined;
  return row ? normalizeMembershipConfigRow(row) : undefined;
}

async function getActiveMembershipForUserUsing(
  client: { query(sql: string, params?: unknown[]): Promise<pg.QueryResult> },
  userId: string,
  opts?: { forUpdate?: boolean },
): Promise<UserMembershipRow | null> {
  const { rows } = await client.query(
    `SELECT *
     FROM user_memberships
     WHERE user_id = $1
       AND status = 'active'
       AND current_period_end > NOW()
     ${opts?.forUpdate ? 'FOR UPDATE' : ''}`,
    [userId],
  );
  return (rows[0] as UserMembershipRow | undefined) ?? null;
}

export async function getMembershipOverview(
  userId: string,
): Promise<MembershipOverviewRow> {
  const membership = await getActiveMembershipForUserUsing(pool, userId);
  const config = await getMembershipConfig();
  return { config, membership, active: membership !== null };
}

export async function getMembershipOverviewsByUserIds(
  userIds: string[],
): Promise<Map<string, MembershipOverviewRow>> {
  if (userIds.length === 0) return new Map();
  // Disabling new purchases must not hide an existing user's membership.
  const config = await getMembershipConfig();
  const result = new Map<string, MembershipOverviewRow>(
    userIds.map((userId) => [
      userId,
      { config, membership: null, active: false },
    ]),
  );
  const { rows } = await pool.query(
    `SELECT *
     FROM user_memberships
     WHERE user_id = ANY($1::text[])
       AND status = 'active'
       AND current_period_end > NOW()`,
    [userIds],
  );
  for (const membership of rows as UserMembershipRow[]) {
    result.set(membership.user_id, { config, membership, active: true });
  }
  return result;
}

export async function getMembershipEntitlements(
  userId: string,
): Promise<MembershipEntitlementRow[]> {
  const membership = await getActiveMembershipForUserUsing(pool, userId);
  if (!membership) return [];
  const config = await getMembershipConfig();
  return [
    {
      plan_key: membership.plan_key,
      name: config.name,
      effective_start: new Date(membership.current_period_start).toISOString(),
      effective_end: new Date(membership.current_period_end).toISOString(),
      is_current:
        new Date(membership.current_period_start).getTime() <= Date.now(),
    },
  ];
}

/** 会员订阅 DB 层幂等去抖窗口：与 billing-service 的 Redis 去抖同量级，作为 Redis 失效时的兜底。 */
const MEMBERSHIP_SUBSCRIBE_IDEMPOTENCY_WINDOW_MS = 10_000;

/**
 * 会员订阅在 DB 幂等去抖窗口内被判定为重复提交时抛出。
 *
 * @remarks 上层（billing-service）据此返回 409「请勿重复提交」，语义与 Redis 去抖一致；
 *   且不应据此删除 Redis 去抖锁——这是正常的重复拦截，不是开通失败。
 */
export class MembershipSubscribeDebounceError extends Error {
  constructor() {
    super('订阅处理中，请勿重复提交');
    this.name = 'MembershipSubscribeDebounceError';
  }
}

/**
 * 使用积分余额开通或续费一个月指定 FateClaw 会员套餐。
 */
export async function subscribeMembershipWithWallet(
  userId: string,
  planKey: MembershipPlanKey = MEMBERSHIP_PLAN_KEY,
): Promise<{ user: User; overview: MembershipOverviewRow }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const config = await getMembershipConfigUsing({
      query: client.query.bind(client),
    });
    if (!config.enabled) {
      throw new Error('会员暂未开放');
    }
    const user = await getUserByIdUsing(client, userId, { forUpdate: true });
    if (!user) {
      throw new Error('用户不存在');
    }

    // DB 层幂等去抖：user 行 FOR UPDATE 锁已串行化同一用户的并发订阅，但串行后第二个事务
    // 仍会重复扣费。这里在锁内检查「距上次会员订阅是否在去抖窗口内」，命中即判定为连点/重试/
    // Redis 去抖失效导致的重复提交，抛错交上层拦截，杜绝 Redis 不可用时的重复扣费与周期叠加。
    // 全程用数据库时钟：created_at 由 NOW() 写入，若改用应用侧 Date.now() 比较，应用机与 DB 机的
    // 时钟偏移会让窗口失真（偏快则去抖永不命中、偏慢则误拦正常续费）。WHERE 直接带窗口条件，命中
    // (kind, created_at DESC) 索引后在窗口边界即终止，不做「取最近一条再回表」的全量倒序扫描。
    const { rows: dupRows } = await client.query<{ duplicate: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM wallet_transactions
         WHERE user_id = $1 AND kind = 'membership_subscription'
           AND created_at > NOW() - ($2::int * interval '1 millisecond')
       ) AS duplicate`,
      [userId, MEMBERSHIP_SUBSCRIBE_IDEMPOTENCY_WINDOW_MS],
    );
    if (dupRows[0]?.duplicate) {
      throw new MembershipSubscribeDebounceError();
    }

    const priceCoins = roundCoinsToCents(config.monthly_price_coins);
    const deduction = await deductBalanceCoins(
      client,
      normalizeUserCoins(user),
      priceCoins,
    );
    const updatedUser = await getUserByIdUsing(client, userId, {
      forUpdate: true,
    });
    if (!updatedUser) {
      throw new Error('用户不存在');
    }

    const currentMembership = await getActiveMembershipForUserUsing(
      client,
      userId,
      { forUpdate: true },
    );
    const now = new Date();
    const membershipActive = Boolean(
      currentMembership &&
      new Date(currentMembership.current_period_end).getTime() > now.getTime(),
    );
    // Renewals preserve the original period anchor and extend the existing end date.
    const periodStart =
      membershipActive && currentMembership
        ? resolveMembershipPeriodStart(currentMembership, now)
        : now;
    const periodEnd = addMonths(
      membershipActive && currentMembership
        ? new Date(currentMembership.current_period_end)
        : now,
      1,
    );
    const { rows: membershipRows } = await client.query(
      `INSERT INTO user_memberships (
         user_id, plan_key, status, current_period_start,
         current_period_end, created_at, updated_at
       )
       VALUES ($1, $2, 'active', $3, $4, NOW(), NOW())
       ON CONFLICT (user_id, plan_key) DO UPDATE SET
         status = 'active',
         current_period_start = EXCLUDED.current_period_start,
         current_period_end = EXCLUDED.current_period_end,
         updated_at = NOW()
       RETURNING *`,
      [userId, planKey, periodStart.toISOString(), periodEnd.toISOString()],
    );
    const membership = membershipRows[0] as UserMembershipRow;

    // membership_subscription 是历史钱包流水 kind，代表会员购买/续费流水，不是 Skill subscription。
    await insertWalletTransaction(client, {
      userId,
      kind: 'membership_subscription',
      amountCoins: -priceCoins,
      balanceSource: deduction.balanceSource,
      note: `${config.name} 会员月费`,
      metadata: {
        planKey,
        periodStart: membership.current_period_start,
        periodEnd: membership.current_period_end,
        bonusDeducted: deduction.bonusDeducted,
        purchasedDeducted: deduction.purchasedDeducted,
      },
    });

    await client.query('COMMIT');
    return {
      user: normalizeUserCoins(updatedUser),
      overview: {
        config,
        membership,
        active: true,
      },
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 管理员直接设置用户会员有效期，不扣减用户积分余额。
 *
 * @param input.userId 目标用户 ID。
 * @param input.planKey The membership identity validated by the HTTP boundary.
 * @param input.currentPeriodEnd 会员有效期结束时间，必须晚于当前时间。
 * @returns 写入后的会员周期记录。
 * @remarks 仅供管理后台人工处理补偿、续期或纠错；正常购买仍应使用钱包订阅流程。
 */
export async function setUserMembershipForAdmin(input: {
  userId: string;
  planKey: MembershipPlanKey;
  currentPeriodEnd: string;
}): Promise<UserMembershipRow> {
  const periodEnd = new Date(input.currentPeriodEnd);
  if (!Number.isFinite(periodEnd.getTime())) {
    throw new Error('会员有效期格式不正确');
  }
  if (periodEnd.getTime() <= Date.now()) {
    throw new Error('会员有效期必须晚于当前时间');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const config = await getMembershipConfigUsing({
      query: client.query.bind(client),
    });
    if (!config.enabled) {
      throw new Error('会员套餐未启用');
    }

    const user = await getUserByIdUsing(client, input.userId, {
      forUpdate: true,
    });
    if (!user) {
      throw new Error('用户不存在');
    }

    const now = new Date();
    const { rows: existingRows } = await client.query(
      `SELECT *
       FROM user_memberships
       WHERE user_id = $1 AND plan_key = $2
       FOR UPDATE`,
      [input.userId, input.planKey],
    );
    const existing = existingRows[0] as UserMembershipRow | undefined;
    const existingEnd = existing
      ? new Date(existing.current_period_end).getTime()
      : 0;
    // 同套餐续期保留原周期锚点，避免重置当前会员周期。
    const periodStart =
      existing?.status === 'active' && existingEnd > now.getTime()
        ? existing.current_period_start
        : now.toISOString();

    const { rows: membershipRows } = await client.query(
      `INSERT INTO user_memberships (
         user_id, plan_key, status, current_period_start,
         current_period_end, created_at, updated_at
       )
       VALUES ($1, $2, 'active', $3, $4, NOW(), NOW())
       ON CONFLICT (user_id, plan_key) DO UPDATE SET
         status = 'active',
         current_period_start = EXCLUDED.current_period_start,
         current_period_end = EXCLUDED.current_period_end,
         updated_at = NOW()
       RETURNING *`,
      [input.userId, input.planKey, periodStart, periodEnd.toISOString()],
    );
    const membership = membershipRows[0] as UserMembershipRow;
    await client.query('COMMIT');
    return membership;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 管理员立即停用用户当前和未来的会员权益。
 *
 * @param userId 目标用户 ID。
 * @returns 被停用的会员记录数量。
 * @remarks 不删除历史额度流水，只将有效会员周期标记为 cancelled 以保留审计线索。
 */
export async function cancelUserMembershipsForAdmin(
  userId: string,
): Promise<{ cancelledCount: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await getUserByIdUsing(client, userId, { forUpdate: true });
    if (!user) {
      throw new Error('用户不存在');
    }
    const result = await client.query(
      `UPDATE user_memberships
       SET status = 'cancelled',
           current_period_end = CASE
             WHEN current_period_start < NOW() THEN LEAST(current_period_end, NOW())
             ELSE current_period_start + INTERVAL '1 millisecond'
           END,
           updated_at = NOW()
       WHERE user_id = $1
         AND status = 'active'
         AND current_period_end > NOW()`,
      [userId],
    );
    await client.query('COMMIT');
    return { cancelledCount: result.rowCount ?? 0 };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
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
  const { rows } = await pool.query(
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
  const { rows } = await pool.query(
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
    throw new Error('补充积分订单不存在');
  }
  return normalizeRechargeOrderRow(rows[0] as RechargeOrderRow);
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
  const row = rows[0] as RechargeOrderRow | undefined;
  return row ? normalizeRechargeOrderRow(row) : undefined;
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
  const row = rows[0] as RechargeOrderRow | undefined;
  return row ? normalizeRechargeOrderRow(row) : undefined;
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

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*) AS cnt
     FROM recharge_orders ro
     ${whereClause}`,
    values,
  );

  const { rows } = await pool.query(
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
  const { rows } = await pool.query(
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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

    await client.query(
      `UPDATE users
       SET purchased_coins = purchased_coins + $1
       WHERE id = $2`,
      [order.amount_coins, order.user_id],
    );

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
    return normalizeRechargeOrderRow(updatedRows[0] as RechargeOrderRow);
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
  const { rows } = await pool.query(
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
  const { rows } = await pool.query(
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

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*) AS cnt
     FROM billing_request_reservations
     ${whereClause}`,
    values,
  );

  const { rows } = await pool.query(
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
  const { rows } = await pool.query(
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
  const { rows } = await pool.query(
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

export async function getWalletTransactionsByUserId(
  userId: string,
  limit = 20,
): Promise<WalletTransactionRow[]> {
  const { rows } = await pool.query(
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

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*) AS cnt
     FROM wallet_transactions wt
     ${whereClause}`,
    values,
  );

  const { rows } = await pool.query(
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
  const { rows } = await pool.query(
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

// =====================
// --- Balance grants / 余额扣减算法 ---
// =====================

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
  const client = await pool.connect();
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
  const client = await pool.connect();
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
  const { rows } = await pool.query(
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
  const client = await pool.connect();
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
  const client = await pool.connect();
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
  const client = await pool.connect();
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
  const client = await pool.connect();
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
  const { rows } = await pool.query(
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
  const { rows } = await pool.query(
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
