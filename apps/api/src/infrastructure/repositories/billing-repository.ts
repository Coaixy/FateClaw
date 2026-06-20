import crypto from 'node:crypto';

import pg from 'pg';

import { getDbPool } from '../db-pool.js';
import { logger } from '../logger.js';
import { settleReferralMembershipRewardUsing } from './referrals-repository.js';
import { getUserByIdUsing } from './users-repository.js';
import type {
  BalanceGrantSource,
  MembershipAllowance,
  MembershipConfig,
  User,
  UserMembership,
} from '../../shared/types.js';
import {
  assertSufficientSpendableCoins,
  calculateAvailableSpendableCoins,
} from '../../shared/balance-coins.js';
import { resolveMembershipAllowancePeriod } from '../../shared/membership-cycle.js';
import {
  MEMBERSHIP_CLARITY_PLAN_KEY,
  MEMBERSHIP_DEEP_PLAN_KEY,
  MEMBERSHIP_INSIGHT_PLAN_KEY,
  ACTIVE_MEMBERSHIP_PLAN_KEYS,
  type MembershipPlanKey,
  hasPaidMembershipEntitlement,
  normalizeMembershipPlanKey,
  resolveMembershipConfigId,
  resolveMembershipPlanKey,
  resolveMembershipPlanName,
  resolveMembershipPlanRank,
} from '../../shared/membership-plans.js';

const pool = {
  query(sql: string, params?: unknown[]) {
    return getDbPool().query(sql, params);
  },
  connect() {
    return getDbPool().connect();
  },
};

const COIN_CENTS = 100;
const MEMBERSHIP_UNIT_DENOMINATOR = 1_000_000;

function toCoins(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function roundCoinsToCents(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * COIN_CENTS) / COIN_CENTS;
}

function roundAllowanceUnits(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * COIN_CENTS) / COIN_CENTS;
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

function normalizeDailySignInConfigRow(
  row: DailySignInConfigRow,
): DailySignInConfigRow {
  return {
    ...row,
    reward_coins: toCoins(row.reward_coins),
  };
}

function normalizeDailySignInRecordRow(
  row: DailySignInRecordRow,
): DailySignInRecordRow {
  return {
    ...row,
    reward_coins: toCoins(row.reward_coins),
  };
}

function normalizeFreeProfessionalAiQuotaConfigRow(
  row: FreeProfessionalAiQuotaConfigRow,
): FreeProfessionalAiQuotaConfigRow {
  return {
    ...row,
    daily_professional_turn_limit: Math.max(
      0,
      Math.trunc(Number(row.daily_professional_turn_limit ?? 0)),
    ),
  };
}

function normalizeProfessionalAiDailyUsageRow(
  row: ProfessionalAiDailyUsageRow,
): ProfessionalAiDailyUsageRow {
  return {
    ...row,
    professional_turn_count: Math.max(
      0,
      Math.trunc(Number(row.professional_turn_count ?? 0)),
    ),
  };
}

function normalizeFreeProfessionalAiDailyUsageRow(
  row: FreeProfessionalAiDailyUsageRow,
): FreeProfessionalAiDailyUsageRow {
  return normalizeProfessionalAiDailyUsageRow(row);
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

function normalizeGiftCodeRow(row: GiftCodeRow): GiftCodeRow {
  const amountCoins = toCoins(row.amount_coins);
  const maxRedemptions = Math.max(
    1,
    Math.trunc(Number(row.max_redemptions ?? 1)),
  );
  const redeemedCount = Math.min(
    maxRedemptions,
    Math.max(0, Math.trunc(Number(row.redeemed_count ?? 0))),
  );
  const expired = row.expires_at
    ? new Date(row.expires_at).getTime() <= Date.now()
    : false;
  const status: GiftCodeStatus = !row.enabled
    ? 'disabled'
    : expired
      ? 'expired'
      : redeemedCount >= maxRedemptions
        ? 'exhausted'
        : 'active';
  return {
    ...row,
    amount_coins: amountCoins,
    max_redemptions: maxRedemptions,
    redeemed_count: redeemedCount,
    status,
  };
}

function normalizeGiftCodeRedemptionRow(
  row: GiftCodeRedemptionRow,
): GiftCodeRedemptionRow {
  return {
    ...row,
    amount_coins: toCoins(row.amount_coins),
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
  const planKey = resolveMembershipPlanKey(row.id);
  const monthlyPriceCoins = toCoins(row.monthly_price_coins);
  return {
    ...row,
    name: row.name || resolveMembershipPlanName(planKey),
    monthly_price_coins: monthlyPriceCoins,
    display_price_coins: Math.max(
      monthlyPriceCoins,
      toCoins(row.display_price_coins),
    ),
    monthly_allowance_units: roundAllowanceUnits(
      Number(row.monthly_allowance_units ?? 0),
    ),
    standard_price_per_million_units_coins: toCoins(
      row.standard_price_per_million_units_coins,
    ),
  };
}

function normalizeMembershipAllowanceRow(
  row: MembershipAllowance,
): MembershipAllowance {
  return {
    ...row,
    allowance_units: roundAllowanceUnits(Number(row.allowance_units ?? 0)),
    used_units: roundAllowanceUnits(Number(row.used_units ?? 0)),
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
 * 单次模型请求结算结果，包含积分实扣和会员免费额度抵扣明细。
 */
export interface ModelChargeSettlementResult {
  actualChargeCoins: number;
  rawChargeCoins: number;
  membershipCoveredCoins: number;
  membershipConsumedUnits: number;
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

export type GiftCodeBalanceType = 'purchased' | 'bonus';
export type GiftCodeUsageType = 'single' | 'multi';
export type GiftCodeStatus = 'active' | 'disabled' | 'expired' | 'exhausted';

/** 积分礼品码主表行，status 为运行时派生状态。 */
export interface GiftCodeRow {
  id: string;
  code: string;
  name: string;
  balance_type: GiftCodeBalanceType;
  usage_type: GiftCodeUsageType;
  amount_coins: number;
  max_redemptions: number;
  redeemed_count: number;
  enabled: boolean;
  expires_at: string | null;
  created_by: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
  status: GiftCodeStatus;
}

/** 礼品码兑换记录，用于防止同一用户重复兑换同一个多次码。 */
export interface GiftCodeRedemptionRow {
  id: string;
  gift_code_id: string;
  user_id: string;
  wallet_transaction_id: string | null;
  balance_grant_id: string | null;
  balance_type: GiftCodeBalanceType;
  amount_coins: number;
  redeemed_at: string;
}

/** 管理后台礼品码列表分页响应。 */
export interface AdminGiftCodeListResult {
  gift_codes: GiftCodeRow[];
  total: number;
}

/** 用户兑换礼品码后的余额结果。 */
export interface GiftCodeRedeemResult {
  gift_code: GiftCodeRow;
  redemption: GiftCodeRedemptionRow;
  purchased_coins: number;
  bonus_coins: number;
  reserved_coins: number;
  available_coins: number;
}

/** 每日签到积分奖励的全局配置行。 */
export interface DailySignInConfigRow {
  id: 'default' | string;
  enabled: boolean;
  reward_coins: number;
  updated_at: string;
}

/** 用户每日签到记录，依靠 user_id + sign_in_date 保证每日幂等。 */
export interface DailySignInRecordRow {
  id: string;
  user_id: string;
  sign_in_date: string;
  reward_coins: number;
  balance_grant_id: string | null;
  created_at: string;
}

/** @deprecated 仅供后台展示旧 Free 专家次数配置兼容，新会员规则不读取该配置。 */
export interface FreeProfessionalAiQuotaConfigRow {
  id: 'default' | string;
  daily_professional_turn_limit: number;
  updated_at: string;
}

/** 专家模式 AI 单日已消耗次数。 */
export interface ProfessionalAiDailyUsageRow {
  user_id: string;
  usage_date: string;
  professional_turn_count: number;
  created_at: string;
  updated_at: string;
}

/** 专家模式 AI 每日次数占用结果。 */
export interface ProfessionalAiTurnClaimResult {
  allowed: boolean;
  usage_date: string;
  limit: number;
  used: number;
  remaining: number;
}

/** 专家模式 AI 每日次数退回结果。 */
export interface ProfessionalAiTurnReleaseResult {
  released: boolean;
  usage_date: string;
  used: number;
}

/** @deprecated 仅供旧 Free quota 代码兼容，新逻辑使用 ProfessionalAiDailyUsageRow。 */
export type FreeProfessionalAiDailyUsageRow = ProfessionalAiDailyUsageRow;
/** @deprecated 仅供旧 Free quota 代码兼容，新逻辑使用 ProfessionalAiTurnClaimResult。 */
export type FreeProfessionalAiTurnClaimResult = ProfessionalAiTurnClaimResult;
/** @deprecated 仅供旧 Free quota 代码兼容，新逻辑使用 ProfessionalAiTurnReleaseResult。 */
export type FreeProfessionalAiTurnReleaseResult =
  ProfessionalAiTurnReleaseResult;

export type MembershipConfigRow = MembershipConfig;
export type UserMembershipRow = UserMembership;
export type MembershipAllowanceRow = MembershipAllowance;

export interface MembershipOverviewRow {
  config: MembershipConfigRow;
  membership: UserMembershipRow | null;
  allowance: MembershipAllowanceRow | null;
  active: boolean;
}

/** 前端展示用的会员权益时间轴片段，已按高档套餐覆盖关系裁剪。 */
export interface MembershipEntitlementRow {
  plan_key: MembershipPlanKey;
  name: string;
  effective_start: string;
  effective_end: string;
  is_current: boolean;
}

async function getMembershipConfigUsing(input: {
  query(sql: string, params?: unknown[]): Promise<pg.QueryResult>;
  planKey?: string;
}): Promise<MembershipConfigRow> {
  const planKey = normalizeMembershipPlanKey(input.planKey);
  const configId = resolveMembershipConfigId(planKey);
  const name = resolveMembershipPlanName(planKey);
  // 旧档（deep/insight）定价仅用于按需补齐存量会员的 config 行以识别其历史档位，
  // 不再进入在售列表（getMembershipPlanConfigs 只 ensure clarity）。在售档 clarity = 10。
  const monthlyPriceCoins =
    planKey === MEMBERSHIP_DEEP_PLAN_KEY
      ? 100
      : planKey === MEMBERSHIP_INSIGHT_PLAN_KEY
        ? 30
        : 10;
  const displayPriceCoins =
    planKey === MEMBERSHIP_DEEP_PLAN_KEY ? 120 : monthlyPriceCoins;
  const monthlyAllowanceUnits =
    planKey === MEMBERSHIP_CLARITY_PLAN_KEY ? 0 : 3_000_000;
  const { rows } = await input.query(
    `INSERT INTO membership_config (
       id, name, monthly_price_coins, display_price_coins,
       monthly_allowance_units
     )
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
     RETURNING *`,
    [
      configId,
      name,
      monthlyPriceCoins,
      displayPriceCoins,
      monthlyAllowanceUnits,
    ],
  );
  return normalizeMembershipConfigRow(rows[0] as MembershipConfigRow);
}

/**
 * 读取会员全局配置；首次访问时补齐默认 FateClaw Clarity 配置。
 */
export async function getMembershipConfig(
  planKey: string = MEMBERSHIP_CLARITY_PLAN_KEY,
): Promise<MembershipConfigRow> {
  return getMembershipConfigUsing({
    query: pool.query,
    planKey,
  });
}

/**
 * 读取所有会员套餐配置；首次访问时补齐 Clarity、Insight 和 Deep 默认配置。
 */
export async function getMembershipPlanConfigs(): Promise<
  MembershipConfigRow[]
> {
  // 单层"卦师使用权"：只 ensure / 暴露在售档（clarity）。停用的旧档（insight/deep）
  // 仍能被 getMembershipConfig 单独读到用于识别存量会员，但不再进入可订阅列表，
  // 也不再被这里 ensure 重建（ACTIVE_MEMBERSHIP_PLAN_KEYS 仅含 clarity）。
  const configs = await Promise.all(
    ACTIVE_MEMBERSHIP_PLAN_KEYS.map((planKey) => getMembershipConfig(planKey)),
  );
  // 在售档只有 clarity，无需再按档位排序。
  return configs.filter((config) => config.enabled);
}

/**
 * 更新会员价格和每周期标准额度。
 */
export async function updateMembershipConfig(input: {
  planKey?: string;
  enabled: boolean;
  name?: string;
  monthlyPriceCoins: number;
  displayPriceCoins?: number;
}): Promise<MembershipConfigRow> {
  const planKey = normalizeMembershipPlanKey(input.planKey);
  const configId = resolveMembershipConfigId(planKey);
  const monthlyPriceCoins = roundCoinsToCents(input.monthlyPriceCoins);
  const displayPriceCoins = roundCoinsToCents(
    input.displayPriceCoins ?? input.monthlyPriceCoins,
  );
  // 单层「卦师使用权」不再由 admin 配置免费额度：仅更新价格与名称。
  // allowance/standard 列不在写入集——INSERT 时用 DB 默认值；clarity 行已存在故走
  // ON CONFLICT UPDATE，不更新这两列即保留存量值（clarity 恒为 0），与温和档一致。
  const { rows } = await pool.query(
    `INSERT INTO membership_config (
       id, enabled, name, monthly_price_coins, display_price_coins,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (id) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       name = EXCLUDED.name,
       monthly_price_coins = EXCLUDED.monthly_price_coins,
       display_price_coins = EXCLUDED.display_price_coins,
       updated_at = NOW()
     RETURNING *`,
    [
      configId,
      input.enabled,
      input.name?.trim() || resolveMembershipPlanName(planKey),
      monthlyPriceCoins,
      Math.max(monthlyPriceCoins, displayPriceCoins),
    ],
  );
  return normalizeMembershipConfigRow(rows[0] as MembershipConfigRow);
}

function calculateMembershipCostUnits(
  costCoins: number,
  config: MembershipConfigRow,
): number {
  if (costCoins <= 0) return 0;
  const units =
    (costCoins * MEMBERSHIP_UNIT_DENOMINATOR) /
    config.standard_price_per_million_units_coins;
  return roundAllowanceUnits(units);
}

async function getActiveMembershipForUserUsing(
  client: pg.PoolClient,
  userId: string,
  opts?: { forUpdate?: boolean },
): Promise<UserMembershipRow | null> {
  const memberships = await getActiveMembershipsForUserUsing(
    client,
    userId,
    opts,
  );
  const { membership } = await resolveEffectiveMembershipUsing({
    query: client.query.bind(client),
    memberships,
  });
  return membership;
}

async function getActiveMembershipsForUserUsing(
  client: pg.PoolClient,
  userId: string,
  opts?: { forUpdate?: boolean },
): Promise<UserMembershipRow[]> {
  const { rows } = await client.query(
    `SELECT *
     FROM user_memberships
     WHERE user_id = $1
       AND status = 'active'
       AND current_period_end > NOW()
     ORDER BY CASE plan_key
       -- 旧 Plus/Pro 只用于历史会员行排序兜底，新的写入路径必须使用三档新 key。
       WHEN 'fateclaw_deep' THEN 3
       WHEN 'fateclaw_pro' THEN 3
       WHEN 'fateclaw_insight' THEN 2
       WHEN 'fateclaw_plus' THEN 2
       WHEN 'fateclaw_clarity' THEN 1
       ELSE 0
     END DESC,
     current_period_end DESC
     ${opts?.forUpdate ? 'FOR UPDATE' : ''}`,
    [userId],
  );
  return rows as UserMembershipRow[];
}

async function getEffectiveMembershipEntitlementsUsing(input: {
  query(sql: string, params?: unknown[]): Promise<pg.QueryResult>;
  userId: string;
  now: Date;
}): Promise<MembershipEntitlementRow[]> {
  const { rows } = await input.query(
    `SELECT *
     FROM user_memberships
     WHERE user_id = $1
       AND status = 'active'
       AND current_period_end > $2
     ORDER BY current_period_start ASC, current_period_end ASC`,
    [input.userId, input.now.toISOString()],
  );
  const configs = new Map(
    (
      await Promise.all(
        ACTIVE_MEMBERSHIP_PLAN_KEYS.map((planKey) =>
          getMembershipConfigUsing({ query: input.query, planKey }),
        ),
      )
    ).map((config) => [resolveMembershipPlanKey(config.id), config]),
  );
  const activeMemberships = (rows as UserMembershipRow[])
    .map((membership) => {
      const planKey = normalizeMembershipPlanKey(membership.plan_key);
      return {
        planKey,
        startMs: new Date(membership.current_period_start).getTime(),
        endMs: new Date(membership.current_period_end).getTime(),
        rank: resolveMembershipPlanRank(planKey),
      };
    })
    .filter((entry) => entry.endMs > entry.startMs);

  const boundaries = Array.from(
    new Set(activeMemberships.flatMap((entry) => [entry.startMs, entry.endMs])),
  ).sort((a, b) => a - b);
  const entitlements: MembershipEntitlementRow[] = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const startMs = boundaries[index] ?? 0;
    const endMs = boundaries[index + 1] ?? 0;
    if (endMs <= startMs || endMs <= input.now.getTime()) continue;

    const effective = activeMemberships
      .filter((entry) => entry.startMs < endMs && entry.endMs > startMs)
      .sort((a, b) => {
        const rankDelta = b.rank - a.rank;
        if (rankDelta !== 0) return rankDelta;
        return b.endMs - a.endMs;
      })[0];
    if (!effective) continue;

    const previous = entitlements.at(-1);
    if (previous?.plan_key === effective.planKey) {
      previous.effective_end = new Date(endMs).toISOString();
      continue;
    }

    // 时间轴只表达用户实际会享受到的套餐，低档被高档覆盖的区间不单独展示。
    entitlements.push({
      plan_key: effective.planKey,
      name:
        configs.get(effective.planKey)?.name ??
        resolveMembershipPlanName(effective.planKey),
      effective_start: new Date(startMs).toISOString(),
      effective_end: new Date(endMs).toISOString(),
      is_current: startMs <= input.now.getTime() && input.now.getTime() < endMs,
    });
  }

  return entitlements;
}

async function resolveEffectiveMembershipUsing(input: {
  query(sql: string, params?: unknown[]): Promise<pg.QueryResult>;
  memberships: UserMembershipRow[];
}): Promise<{
  membership: UserMembershipRow | null;
  config: MembershipConfigRow;
}> {
  const sortedMemberships = [...input.memberships]
    .filter(
      (membership) =>
        membership.status === 'active' &&
        new Date(membership.current_period_end).getTime() > Date.now(),
    )
    .sort((a, b) => {
      const rankDelta =
        resolveMembershipPlanRank(b.plan_key) -
        resolveMembershipPlanRank(a.plan_key);
      if (rankDelta !== 0) return rankDelta;
      return (
        new Date(b.current_period_end).getTime() -
        new Date(a.current_period_end).getTime()
      );
    });

  const membership = sortedMemberships[0] ?? null;
  return {
    membership,
    config: await getMembershipConfigUsing({
      query: input.query,
      planKey: membership?.plan_key,
    }),
  };
}

/**
 * 高档权益插队时，把被覆盖的低档会员时长顺延到末尾。
 *
 * @deprecated 单层化后只有 clarity 一档在售（rank=1），targetRank 恒为 1，
 *   循环内 `rank >= targetRank` 恒成立 → 直接 continue，UPDATE 永不执行（死分支）。
 *   保留以兼容存量未迁移的多档行（理论上 0054 已归一），并保持订阅路径调用点不变。
 *   若未来确认无存量多档需求，可连同调用点一并物理删除。
 */
async function extendLowerTierMembershipsForOverlayUsing(
  client: pg.PoolClient,
  input: {
    userId: string;
    planKey: MembershipPlanKey;
    overlayStart: Date;
    overlayEnd: Date;
    memberships: UserMembershipRow[];
  },
): Promise<void> {
  const targetRank = resolveMembershipPlanRank(input.planKey);
  for (const membership of input.memberships) {
    if (resolveMembershipPlanRank(membership.plan_key) >= targetRank) {
      continue;
    }
    const lowerStart = new Date(membership.current_period_start);
    const lowerEnd = new Date(membership.current_period_end);
    const overlapStart = Math.max(
      lowerStart.getTime(),
      input.overlayStart.getTime(),
    );
    const overlapEnd = Math.min(lowerEnd.getTime(), input.overlayEnd.getTime());
    const coveredMilliseconds = overlapEnd - overlapStart;
    if (coveredMilliseconds <= 0) {
      continue;
    }

    // 高档权益插队期间低档权益暂停消耗，因此把被覆盖的低档时长顺延到末尾。
    await client.query(
      `UPDATE user_memberships
       SET current_period_end =
             current_period_end + ($3::double precision * INTERVAL '1 millisecond'),
           updated_at = NOW()
       WHERE user_id = $1 AND plan_key = $2`,
      [input.userId, membership.plan_key, coveredMilliseconds],
    );
  }
}

async function ensureMembershipAllowanceForUserUsing(
  client: pg.PoolClient,
  input: {
    membership: UserMembershipRow;
    config: MembershipConfigRow;
  },
): Promise<MembershipAllowanceRow> {
  const period = resolveMembershipAllowancePeriod(input.membership);
  // 单层"卦师使用权"额度恒为 0：跳过 INSERT，返回内存零额度行，
  // 停掉每次结算写一行 allowance_units=0 的空转记录。consume 拿到后
  // remainingUnits=0 → consumedUnits=0（提前返回），与写库行为等价。
  if (input.config.monthly_allowance_units <= 0) {
    const nowIso = new Date().toISOString();
    return {
      id: '',
      user_id: input.membership.user_id,
      plan_key: input.membership.plan_key,
      period_start: period.start,
      period_end: period.end,
      allowance_units: 0,
      used_units: 0,
      created_at: nowIso,
      updated_at: nowIso,
    };
  }
  const allowanceId = `mta-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { rows } = await client.query(
    `INSERT INTO membership_allowances (
       id, user_id, plan_key, period_start, period_end,
       allowance_units, used_units, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, 0, NOW(), NOW())
     ON CONFLICT (user_id, plan_key, period_start) DO UPDATE
       SET period_end = EXCLUDED.period_end,
           allowance_units = GREATEST(
             membership_allowances.allowance_units,
             EXCLUDED.allowance_units
           ),
           updated_at = NOW()
     RETURNING *`,
    [
      allowanceId,
      input.membership.user_id,
      input.membership.plan_key,
      period.start,
      period.end,
      input.config.monthly_allowance_units,
    ],
  );
  return normalizeMembershipAllowanceRow(rows[0] as MembershipAllowanceRow);
}

async function consumeMembershipAllowanceUsing(
  client: pg.PoolClient,
  input: {
    userId: string;
    chargeCoins: number;
    config: MembershipConfigRow;
    membership?: UserMembershipRow;
  },
): Promise<{
  consumedUnits: number;
  coveredCoins: number;
  allowance: MembershipAllowanceRow | null;
}> {
  const membership =
    input.membership ??
    (await getActiveMembershipForUserUsing(client, input.userId, {
      forUpdate: true,
    }));
  if (!membership) {
    return { consumedUnits: 0, coveredCoins: 0, allowance: null };
  }

  const allowance = await ensureMembershipAllowanceForUserUsing(client, {
    membership,
    config: input.config,
  });
  const requestedUnits = calculateMembershipCostUnits(
    input.chargeCoins,
    input.config,
  );
  const remainingUnits = Math.max(
    0,
    allowance.allowance_units - allowance.used_units,
  );
  const consumedUnits = roundAllowanceUnits(
    Math.min(requestedUnits, remainingUnits),
  );
  if (consumedUnits <= 0) {
    return { consumedUnits: 0, coveredCoins: 0, allowance };
  }

  const { rows } = await client.query(
    `UPDATE membership_allowances
     SET used_units = LEAST(allowance_units, used_units + $1),
         updated_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [consumedUnits, allowance.id],
  );
  const coveredCoins = roundCoinsToCents(
    (consumedUnits * input.config.standard_price_per_million_units_coins) /
      MEMBERSHIP_UNIT_DENOMINATOR,
  );
  return {
    consumedUnits,
    coveredCoins: Math.min(input.chargeCoins, coveredCoins),
    allowance: normalizeMembershipAllowanceRow(
      rows[0] as MembershipAllowanceRow,
    ),
  };
}

/**
 * 读取用户会员状态和当前周期额度。
 */
export async function getMembershipOverview(
  userId: string,
): Promise<MembershipOverviewRow> {
  const { rows: membershipRows } = await pool.query(
    `SELECT *
     FROM user_memberships
     WHERE user_id = $1
     ORDER BY CASE
       WHEN status = 'active' AND current_period_end > NOW() THEN 1
       ELSE 0
     END DESC,
     CASE plan_key
       -- 旧 Plus/Pro 只用于历史会员行排序兜底，新的写入路径必须使用三档新 key。
       WHEN 'fateclaw_deep' THEN 3
       WHEN 'fateclaw_pro' THEN 3
       WHEN 'fateclaw_insight' THEN 2
       WHEN 'fateclaw_plus' THEN 2
       WHEN 'fateclaw_clarity' THEN 1
       ELSE 0
     END DESC,
     current_period_end DESC,
     updated_at DESC`,
    [userId],
  );
  const memberships = membershipRows as UserMembershipRow[];
  const { membership, config } = await resolveEffectiveMembershipUsing({
    query: pool.query,
    memberships,
  });
  const period = membership
    ? resolveMembershipAllowancePeriod(membership)
    : null;
  const active = Boolean(
    membership &&
    membership.status === 'active' &&
    new Date(membership.current_period_end).getTime() > Date.now(),
  );
  const allowance =
    active && membership && period
      ? await (async () => {
          const { rows } = await pool.query(
            `SELECT *
           FROM membership_allowances
           WHERE user_id = $1 AND plan_key = $2 AND period_start = $3
           LIMIT 1`,
            [userId, membership.plan_key, period.start],
          );
          const row = rows[0] as MembershipAllowanceRow | undefined;
          return row ? normalizeMembershipAllowanceRow(row) : null;
        })()
      : null;

  return { config, membership, allowance, active };
}

/**
 * 批量读取用户会员状态和当前周期额度。
 *
 * @param userIds 当前页用户 ID 列表。
 * @returns userId 到会员 overview 的映射；无有效会员时使用默认套餐配置。
 */
export async function getMembershipOverviewsByUserIds(
  userIds: string[],
): Promise<Map<string, MembershipOverviewRow>> {
  const configs = await getMembershipPlanConfigs();
  const configsByPlan = new Map(
    configs.map((config) => [resolveMembershipPlanKey(config.id), config]),
  );
  const defaultConfig =
    configsByPlan.get(MEMBERSHIP_CLARITY_PLAN_KEY) ?? configs[0];
  if (!defaultConfig) {
    return new Map();
  }
  const result = new Map<string, MembershipOverviewRow>(
    userIds.map((userId) => [
      userId,
      {
        config: defaultConfig,
        membership: null,
        allowance: null,
        active: false,
      },
    ]),
  );
  if (userIds.length === 0) return result;

  const { rows: membershipRows } = await pool.query(
    `SELECT *
     FROM user_memberships
     WHERE user_id = ANY($1::text[])
       AND status = 'active'
       AND current_period_end > NOW()`,
    [userIds],
  );
  const membershipsByUser = new Map<string, UserMembershipRow[]>();
  for (const membership of membershipRows as UserMembershipRow[]) {
    const items = membershipsByUser.get(membership.user_id) ?? [];
    items.push(membership);
    membershipsByUser.set(membership.user_id, items);
  }

  const selectedMemberships = new Map<string, UserMembershipRow>();
  const periodStarts = new Set<string>();
  for (const userId of userIds) {
    const membership = (membershipsByUser.get(userId) ?? []).sort((a, b) => {
      const rankDelta =
        resolveMembershipPlanRank(b.plan_key) -
        resolveMembershipPlanRank(a.plan_key);
      if (rankDelta !== 0) return rankDelta;
      return (
        new Date(b.current_period_end).getTime() -
        new Date(a.current_period_end).getTime()
      );
    })[0];
    if (!membership) continue;
    selectedMemberships.set(userId, membership);
    periodStarts.add(resolveMembershipAllowancePeriod(membership).start);
  }

  const allowanceByKey = new Map<string, MembershipAllowanceRow>();
  if (periodStarts.size > 0) {
    const { rows: allowanceRows } = await pool.query(
      `SELECT *
       FROM membership_allowances
       WHERE user_id = ANY($1::text[])
         AND period_start = ANY($2::timestamptz[])`,
      [userIds, [...periodStarts]],
    );
    for (const allowance of allowanceRows as MembershipAllowanceRow[]) {
      allowanceByKey.set(
        `${allowance.user_id}:${allowance.plan_key}:${allowance.period_start}`,
        normalizeMembershipAllowanceRow(allowance),
      );
    }
  }

  for (const [userId, membership] of selectedMemberships) {
    const planKey = normalizeMembershipPlanKey(membership.plan_key);
    const period = resolveMembershipAllowancePeriod(membership);
    result.set(userId, {
      config: configsByPlan.get(planKey) ?? defaultConfig,
      membership,
      allowance:
        allowanceByKey.get(
          `${userId}:${membership.plan_key}:${period.start}`,
        ) ?? null,
      active: true,
    });
  }

  return result;
}

/**
 * 读取用户当前及未来会实际生效的会员权益时间轴。
 */
export async function getMembershipEntitlements(
  userId: string,
): Promise<MembershipEntitlementRow[]> {
  return getEffectiveMembershipEntitlementsUsing({
    query: pool.query,
    userId,
    now: new Date(),
  });
}

/**
 * 使用积分余额开通或续费一个月指定 FateClaw 会员套餐。
 */
export async function subscribeMembershipWithWallet(
  userId: string,
  planKey: string = MEMBERSHIP_CLARITY_PLAN_KEY,
): Promise<{ user: User; overview: MembershipOverviewRow }> {
  const normalizedPlanKey = normalizeMembershipPlanKey(planKey);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const config = await getMembershipConfigUsing({
      query: client.query.bind(client),
      planKey: normalizedPlanKey,
    });
    if (!config.enabled) {
      throw new Error('会员暂未开放');
    }
    const user = await getUserByIdUsing(client, userId, { forUpdate: true });
    if (!user) {
      throw new Error('用户不存在');
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

    const activeMemberships = await getActiveMembershipsForUserUsing(
      client,
      userId,
      { forUpdate: true },
    );
    const currentSamePlan =
      activeMemberships.find(
        (membership) =>
          normalizeMembershipPlanKey(membership.plan_key) === normalizedPlanKey,
      ) ?? null;
    const currentHigherTier = activeMemberships.find(
      (membership) =>
        resolveMembershipPlanRank(membership.plan_key) >
        resolveMembershipPlanRank(normalizedPlanKey),
    );
    const now = new Date();
    const currentSamePlanActive = Boolean(
      currentSamePlan &&
      new Date(currentSamePlan.current_period_end).getTime() > now.getTime(),
    );
    const baseStart =
      !currentSamePlanActive && currentHigherTier
        ? new Date(currentHigherTier.current_period_end)
        : now;
    const periodStart =
      currentSamePlanActive && currentSamePlan
        ? new Date(
            resolveMembershipAllowancePeriod(currentSamePlan, now).anchor,
          )
        : baseStart;
    const overlayStart =
      currentSamePlanActive && currentSamePlan
        ? new Date(currentSamePlan.current_period_end)
        : baseStart;
    const periodEnd = addMonths(
      currentSamePlanActive && currentSamePlan
        ? new Date(currentSamePlan.current_period_end)
        : baseStart,
      1,
    );
    await extendLowerTierMembershipsForOverlayUsing(client, {
      userId,
      planKey: normalizedPlanKey,
      overlayStart,
      overlayEnd: periodEnd,
      memberships: activeMemberships,
    });
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
      [
        userId,
        normalizedPlanKey,
        periodStart.toISOString(),
        periodEnd.toISOString(),
      ],
    );
    const membership = membershipRows[0] as UserMembershipRow;
    const allowance = await ensureMembershipAllowanceForUserUsing(client, {
      membership,
      config,
    });

    // membership_subscription 是历史钱包流水 kind，代表会员购买/续费流水，不是 Skill subscription。
    const membershipTransactionId = await insertWalletTransaction(client, {
      userId,
      kind: 'membership_subscription',
      amountCoins: -priceCoins,
      balanceSource: deduction.balanceSource,
      note: `${resolveMembershipPlanName(normalizedPlanKey)} 会员月费`,
      metadata: {
        planKey: normalizedPlanKey,
        periodStart: membership.current_period_start,
        periodEnd: membership.current_period_end,
        allowanceUnits: allowance.allowance_units,
        bonusDeducted: deduction.bonusDeducted,
        purchasedDeducted: deduction.purchasedDeducted,
      },
    });
    await settleReferralMembershipRewardUsing(client, {
      inviteeId: userId,
      bonusDeducted: deduction.bonusDeducted,
      purchasedDeducted: deduction.purchasedDeducted,
      priceCoins,
      triggerWalletTransactionId: membershipTransactionId,
    });

    await client.query('COMMIT');
    return {
      user: normalizeUserCoins(updatedUser),
      overview: {
        config,
        membership,
        allowance,
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
 * @param input.planKey 要设置的会员套餐 key；HTTP 写入会拦截未知值，repository 兜底回落到 Clarity。
 * @param input.currentPeriodEnd 会员有效期结束时间，必须晚于当前时间。
 * @returns 写入后的会员周期记录。
 * @remarks 仅供管理后台人工处理补偿、续期或纠错；正常购买仍应使用钱包订阅流程。
 */
export async function setUserMembershipForAdmin(input: {
  userId: string;
  planKey: string;
  currentPeriodEnd: string;
}): Promise<UserMembershipRow> {
  const normalizedPlanKey = normalizeMembershipPlanKey(input.planKey);
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
      planKey: normalizedPlanKey,
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
      [input.userId, normalizedPlanKey],
    );
    const existing = existingRows[0] as UserMembershipRow | undefined;
    const existingEnd = existing
      ? new Date(existing.current_period_end).getTime()
      : 0;
    // 同套餐续期保留原周期锚点，避免重置当前周期已使用的会员免费额度。
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
      [input.userId, normalizedPlanKey, periodStart, periodEnd.toISOString()],
    );
    const membership = membershipRows[0] as UserMembershipRow;
    await ensureMembershipAllowanceForUserUsing(client, {
      membership,
      config,
    });
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

/**
 * 判断用户是否处于有效会员周期。
 */
export async function hasActiveMembership(userId: string): Promise<boolean> {
  const overview = await getMembershipOverview(userId);
  return hasPaidMembershipEntitlement(overview);
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
  return normalizeDailySignInConfigRow(rows[0] as DailySignInConfigRow);
}

/**
 * 更新每日签到开关和每次奖励的积分数量。
 */
export async function updateDailySignInConfig(input: {
  enabled: boolean;
  rewardCoins: number;
}): Promise<DailySignInConfigRow> {
  const { rows } = await pool.query(
    `INSERT INTO daily_sign_in_config (
       id, enabled, reward_coins, updated_at
     )
     VALUES ('default', $1, $2, NOW())
     ON CONFLICT (id) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       reward_coins = EXCLUDED.reward_coins,
       updated_at = NOW()
     RETURNING *`,
    [input.enabled, input.rewardCoins],
  );
  return normalizeDailySignInConfigRow(rows[0] as DailySignInConfigRow);
}

/**
 * 读取旧 Free 用户专业模式 AI 每日次数配置；首次访问时补齐默认 5 次。
 *
 * @returns 当前全局配置行。
 * @deprecated 仅供后台兼容展示旧配置，新会员体系的每日次数来自套餐能力矩阵。
 */
export async function getFreeProfessionalAiQuotaConfig(): Promise<FreeProfessionalAiQuotaConfigRow> {
  const { rows } = await pool.query(
    `INSERT INTO ai_chat_free_quota_config (id)
     VALUES ('default')
     ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
     RETURNING *`,
  );
  return normalizeFreeProfessionalAiQuotaConfigRow(
    rows[0] as FreeProfessionalAiQuotaConfigRow,
  );
}

/**
 * 更新旧 Free 用户专业模式 AI 每日可用次数。
 *
 * @param input.dailyProfessionalTurnLimit 旧配置里的每日专业模式 AI 轮数；0 表示关闭旧免费额度。
 * @returns 更新后的配置行。
 * @deprecated 仅供后台兼容写入旧配置，新会员体系的每日次数来自套餐能力矩阵。
 */
export async function updateFreeProfessionalAiQuotaConfig(input: {
  dailyProfessionalTurnLimit: number;
}): Promise<FreeProfessionalAiQuotaConfigRow> {
  const dailyProfessionalTurnLimit = Math.max(
    0,
    Math.trunc(input.dailyProfessionalTurnLimit),
  );
  const { rows } = await pool.query(
    `INSERT INTO ai_chat_free_quota_config (
       id, daily_professional_turn_limit, updated_at
     )
     VALUES ('default', $1, NOW())
     ON CONFLICT (id) DO UPDATE SET
       daily_professional_turn_limit = EXCLUDED.daily_professional_turn_limit,
       updated_at = NOW()
     RETURNING *`,
    [dailyProfessionalTurnLimit],
  );
  return normalizeFreeProfessionalAiQuotaConfigRow(
    rows[0] as FreeProfessionalAiQuotaConfigRow,
  );
}

/**
 * 原子占用用户一次专家模式 AI 使用次数。
 *
 * @param input.userId 用户 ID。
 * @param input.dailyTurnLimit 当前套餐对应的每日专家模式上限；0 表示不可用。
 * @param input.usageDate 统计日期，默认沿用现有每日用量的 UTC YYYY-MM-DD 口径。
 * @returns allowed=false 表示当天次数已用尽或当前档位不可使用专家模式。
 */
export async function claimProfessionalAiTurn(input: {
  userId: string;
  dailyTurnLimit: number;
  usageDate?: string;
}): Promise<ProfessionalAiTurnClaimResult> {
  const usageDate = input.usageDate ?? new Date().toISOString().slice(0, 10);
  const limit = Math.max(0, Math.trunc(input.dailyTurnLimit));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (limit <= 0) {
      const { rows: usageRows } = await client.query(
        `SELECT *
         FROM ai_chat_professional_daily_usage
         WHERE user_id = $1 AND usage_date = $2`,
        [input.userId, usageDate],
      );
      await client.query('COMMIT');
      const usage = usageRows[0]
        ? normalizeProfessionalAiDailyUsageRow(
            usageRows[0] as ProfessionalAiDailyUsageRow,
          )
        : null;
      return {
        allowed: false,
        usage_date: usageDate,
        limit,
        used: usage?.professional_turn_count ?? 0,
        remaining: 0,
      };
    }

    const { rows: claimRows } = await client.query(
      `INSERT INTO ai_chat_professional_daily_usage (
         user_id, usage_date, professional_turn_count, created_at, updated_at
       )
       VALUES ($1, $2, 1, NOW(), NOW())
       ON CONFLICT (user_id, usage_date) DO UPDATE SET
         professional_turn_count =
           ai_chat_professional_daily_usage.professional_turn_count + 1,
         updated_at = NOW()
       WHERE ai_chat_professional_daily_usage.professional_turn_count < $3
       RETURNING *`,
      [input.userId, usageDate, limit],
    );

    if (claimRows[0]) {
      await client.query('COMMIT');
      const usage = normalizeProfessionalAiDailyUsageRow(
        claimRows[0] as ProfessionalAiDailyUsageRow,
      );
      return {
        allowed: true,
        usage_date: usageDate,
        limit,
        used: usage.professional_turn_count,
        remaining: Math.max(0, limit - usage.professional_turn_count),
      };
    }

    const { rows: usageRows } = await client.query(
      `SELECT *
       FROM ai_chat_professional_daily_usage
       WHERE user_id = $1 AND usage_date = $2`,
      [input.userId, usageDate],
    );
    await client.query('COMMIT');
    const usage = usageRows[0]
      ? normalizeProfessionalAiDailyUsageRow(
          usageRows[0] as ProfessionalAiDailyUsageRow,
        )
      : null;
    return {
      allowed: false,
      usage_date: usageDate,
      limit,
      used: usage?.professional_turn_count ?? 0,
      remaining: 0,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 退回用户一次专家模式 AI 使用次数。
 *
 * @param input.userId 用户 ID。
 * @param input.usageDate 需要退回的统计日期，必须与占用结果的 usage_date 保持一致。
 * @returns released=false 表示没有可退回的次数，通常说明占用未成功或已被补偿。
 */
export async function releaseProfessionalAiTurn(input: {
  userId: string;
  usageDate: string;
}): Promise<ProfessionalAiTurnReleaseResult> {
  const { rows } = await pool.query(
    `UPDATE ai_chat_professional_daily_usage
     SET professional_turn_count = GREATEST(professional_turn_count - 1, 0),
         updated_at = NOW()
     WHERE user_id = $1
       AND usage_date = $2
       AND professional_turn_count > 0
     RETURNING *`,
    [input.userId, input.usageDate],
  );
  const usage = rows[0]
    ? normalizeProfessionalAiDailyUsageRow(
        rows[0] as ProfessionalAiDailyUsageRow,
      )
    : null;
  return {
    released: Boolean(usage),
    usage_date: input.usageDate,
    used: usage?.professional_turn_count ?? 0,
  };
}

/**
 * 原子占用 Free 用户一次专业模式 AI 使用次数。
 *
 * @param input.userId 用户 ID。
 * @param input.usageDate 统计日期，默认沿用现有每日用量的 UTC YYYY-MM-DD 口径。
 * @returns allowed=false 表示当天次数已用尽；allowed=true 时已完成次数递增。
 * @deprecated 仅供旧 Free quota 兼容测试或历史脚本使用，新逻辑使用 claimProfessionalAiTurn()。
 */
export async function claimFreeProfessionalAiTurn(input: {
  userId: string;
  usageDate?: string;
}): Promise<FreeProfessionalAiTurnClaimResult> {
  const usageDate = input.usageDate ?? new Date().toISOString().slice(0, 10);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: configRows } = await client.query(
      `INSERT INTO ai_chat_free_quota_config (id)
       VALUES ('default')
       ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
       RETURNING *`,
    );
    const config = normalizeFreeProfessionalAiQuotaConfigRow(
      configRows[0] as FreeProfessionalAiQuotaConfigRow,
    );
    const limit = config.daily_professional_turn_limit;
    if (limit <= 0) {
      const { rows: usageRows } = await client.query(
        `SELECT *
         FROM ai_chat_free_daily_usage
         WHERE user_id = $1 AND usage_date = $2`,
        [input.userId, usageDate],
      );
      await client.query('COMMIT');
      const usage = usageRows[0]
        ? normalizeFreeProfessionalAiDailyUsageRow(
            usageRows[0] as FreeProfessionalAiDailyUsageRow,
          )
        : null;
      return {
        allowed: false,
        usage_date: usageDate,
        limit,
        used: usage?.professional_turn_count ?? 0,
        remaining: 0,
      };
    }

    const { rows: claimRows } = await client.query(
      `INSERT INTO ai_chat_free_daily_usage (
         user_id, usage_date, professional_turn_count, created_at, updated_at
       )
       VALUES ($1, $2, 1, NOW(), NOW())
       ON CONFLICT (user_id, usage_date) DO UPDATE SET
         professional_turn_count =
           ai_chat_free_daily_usage.professional_turn_count + 1,
         updated_at = NOW()
       WHERE ai_chat_free_daily_usage.professional_turn_count < $3
       RETURNING *`,
      [input.userId, usageDate, limit],
    );

    if (claimRows[0]) {
      await client.query('COMMIT');
      const usage = normalizeFreeProfessionalAiDailyUsageRow(
        claimRows[0] as FreeProfessionalAiDailyUsageRow,
      );
      return {
        allowed: true,
        usage_date: usageDate,
        limit,
        used: usage.professional_turn_count,
        remaining: Math.max(0, limit - usage.professional_turn_count),
      };
    }

    const { rows: usageRows } = await client.query(
      `SELECT *
       FROM ai_chat_free_daily_usage
       WHERE user_id = $1 AND usage_date = $2`,
      [input.userId, usageDate],
    );
    await client.query('COMMIT');
    const usage = usageRows[0]
      ? normalizeFreeProfessionalAiDailyUsageRow(
          usageRows[0] as FreeProfessionalAiDailyUsageRow,
        )
      : null;
    return {
      allowed: false,
      usage_date: usageDate,
      limit,
      used: usage?.professional_turn_count ?? 0,
      remaining: 0,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 退回 Free 用户一次专业模式 AI 使用次数。
 *
 * @param input.userId 用户 ID。
 * @param input.usageDate 需要退回的统计日期，必须与占用结果的 usage_date 保持一致。
 * @returns released=false 表示没有可退回的次数，通常说明占用未成功或已被补偿。
 * @deprecated 仅供旧 Free quota 兼容测试或历史脚本使用，新逻辑使用 releaseProfessionalAiTurn()。
 */
export async function releaseFreeProfessionalAiTurn(input: {
  userId: string;
  usageDate: string;
}): Promise<FreeProfessionalAiTurnReleaseResult> {
  const { rows } = await pool.query(
    `UPDATE ai_chat_free_daily_usage
     SET professional_turn_count = GREATEST(professional_turn_count - 1, 0),
         updated_at = NOW()
     WHERE user_id = $1
       AND usage_date = $2
       AND professional_turn_count > 0
     RETURNING *`,
    [input.userId, input.usageDate],
  );
  const usage = rows[0]
    ? normalizeFreeProfessionalAiDailyUsageRow(
        rows[0] as FreeProfessionalAiDailyUsageRow,
      )
    : null;
  return {
    released: Boolean(usage),
    usage_date: input.usageDate,
    used: usage?.professional_turn_count ?? 0,
  };
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
  const row = rows[0] as DailySignInRecordRow | undefined;
  return row ? normalizeDailySignInRecordRow(row) : undefined;
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

function normalizeGiftCodeText(code: string): string {
  return code.replace(/\s+/g, '').trim().toUpperCase();
}

function generateGiftCodeText(prefix?: string): string {
  const normalizedPrefix =
    prefix
      ?.replace(/[^a-z0-9]/gi, '')
      .slice(0, 12)
      .toUpperCase() || 'GIFT';
  return `${normalizedPrefix}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
}

function isUniqueGiftCodeConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  return (
    record.code === '23505' &&
    (record.constraint === 'gift_codes_code_key' ||
      String(record.detail ?? '').includes('code'))
  );
}

/**
 * 管理员批量生成积分礼品码。
 *
 * @param input 礼品码金额、余额类型、使用方式、生成数量和运营备注。
 * @returns 已创建的礼品码行，包含可复制给用户的 code。
 * @remarks 单次码会强制最大兑换次数为 1；多次码按 maxRedemptions 控制总兑换人数。
 */
export async function createGiftCodesForAdmin(input: {
  name?: string | null;
  balanceType: GiftCodeBalanceType;
  usageType: GiftCodeUsageType;
  amountCoins: number;
  maxRedemptions: number;
  quantity: number;
  expiresAt?: string | null;
  note?: string | null;
  createdBy?: string | null;
  codePrefix?: string | null;
  code?: string | null;
}): Promise<GiftCodeRow[]> {
  if (input.amountCoins <= 0) {
    throw new Error('礼品金额必须为正');
  }
  const quantity = Math.max(1, Math.min(100, Math.trunc(input.quantity || 1)));
  const maxRedemptions =
    input.usageType === 'single'
      ? 1
      : Math.max(1, Math.trunc(input.maxRedemptions || 1));
  const amountCoins = roundCoinsToCents(input.amountCoins);
  const created: GiftCodeRow[] = [];

  for (let index = 0; index < quantity; index += 1) {
    const id = `gift-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const explicitCode =
      input.code && quantity === 1 ? normalizeGiftCodeText(input.code) : null;
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code =
        explicitCode ?? generateGiftCodeText(input.codePrefix ?? undefined);
      try {
        const { rows } = await pool.query(
          `INSERT INTO gift_codes (
             id, code, name, balance_type, usage_type, amount_coins,
             max_redemptions, redeemed_count, enabled, expires_at,
             created_by, note, created_at, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, 0, true, $8, $9, $10, NOW(), NOW())
           RETURNING *`,
          [
            id,
            code,
            input.name?.trim() || '',
            input.balanceType,
            input.usageType,
            amountCoins,
            maxRedemptions,
            input.expiresAt ?? null,
            input.createdBy ?? null,
            input.note?.trim() || null,
          ],
        );
        created.push(normalizeGiftCodeRow(rows[0] as GiftCodeRow));
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (explicitCode || !isUniqueGiftCodeConflict(error)) {
          throw error;
        }
      }
    }
    if (lastError) {
      throw lastError;
    }
  }

  return created;
}

/**
 * 分页查询后台礼品码列表。
 *
 * @param opts 可按派生状态和余额类型过滤，分页上限 200。
 * @returns 管理后台礼品码分页数据。
 */
export async function listGiftCodesForAdmin(opts?: {
  status?: GiftCodeStatus;
  balanceType?: GiftCodeBalanceType;
  limit?: number;
  offset?: number;
}): Promise<AdminGiftCodeListResult> {
  const where: string[] = ['true'];
  const params: unknown[] = [];

  if (opts?.balanceType) {
    params.push(opts.balanceType);
    where.push(`balance_type = $${params.length}`);
  }
  if (opts?.status === 'active') {
    where.push(`enabled = true`);
    where.push(`(expires_at IS NULL OR expires_at > NOW())`);
    where.push(`redeemed_count < max_redemptions`);
  } else if (opts?.status === 'disabled') {
    where.push(`enabled = false`);
  } else if (opts?.status === 'expired') {
    where.push(`enabled = true`);
    where.push(`expires_at IS NOT NULL AND expires_at <= NOW()`);
  } else if (opts?.status === 'exhausted') {
    where.push(`enabled = true`);
    where.push(`(expires_at IS NULL OR expires_at > NOW())`);
    where.push(`redeemed_count >= max_redemptions`);
  }

  const limit = Math.min(opts?.limit ?? 50, 200);
  const offset = Math.max(opts?.offset ?? 0, 0);
  const whereSql = where.join(' AND ');

  const [listResult, countResult] = await Promise.all([
    pool.query(
      `SELECT *
       FROM gift_codes
       WHERE ${whereSql}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1}
       OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total
       FROM gift_codes
       WHERE ${whereSql}`,
      params,
    ),
  ]);

  return {
    gift_codes: (listResult.rows as GiftCodeRow[]).map(normalizeGiftCodeRow),
    total: Number(countResult.rows[0]?.total ?? 0),
  };
}

/**
 * 用户兑换礼品码并原子入账。
 *
 * @param input 当前用户和用户输入的礼品码。
 * @returns 兑换记录、礼品码摘要和兑换后的余额。
 * @remarks 事务内锁定礼品码行，兑换记录唯一键兜底防止同一用户重复兑换。
 */
export async function redeemGiftCodeForUser(input: {
  userId: string;
  code: string;
}): Promise<GiftCodeRedeemResult> {
  const code = normalizeGiftCodeText(input.code);
  if (!code) {
    throw new Error('请输入礼品码');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: giftRows } = await client.query(
      `SELECT *
       FROM gift_codes
       WHERE code = $1
       FOR UPDATE`,
      [code],
    );
    const giftCode = giftRows[0]
      ? normalizeGiftCodeRow(giftRows[0] as GiftCodeRow)
      : null;
    if (!giftCode) {
      throw new Error('礼品码不存在');
    }
    if (giftCode.status === 'disabled') {
      throw new Error('礼品码已停用');
    }
    if (giftCode.status === 'expired') {
      throw new Error('礼品码已过期');
    }
    if (giftCode.status === 'exhausted') {
      throw new Error('礼品码已被领完');
    }

    const user = await getUserByIdUsing(client, input.userId, {
      forUpdate: true,
    });
    if (!user) {
      throw new Error('用户不存在');
    }

    const redemptionId = `giftred-${Date.now()}-${crypto
      .randomBytes(4)
      .toString('hex')}`;
    const { rows: redemptionRows } = await client.query(
      `INSERT INTO gift_code_redemptions (
         id, gift_code_id, user_id, balance_type, amount_coins, redeemed_at
       )
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (gift_code_id, user_id) DO NOTHING
       RETURNING *`,
      [
        redemptionId,
        giftCode.id,
        input.userId,
        giftCode.balance_type,
        giftCode.amount_coins,
      ],
    );
    const insertedRedemption = redemptionRows[0] as
      | GiftCodeRedemptionRow
      | undefined;
    if (!insertedRedemption) {
      throw new Error('你已经兑换过这个礼品码');
    }

    let balanceGrantId: string | null = null;
    let updatedUser: User;
    const note = giftCode.name ? `礼品码兑换：${giftCode.name}` : '礼品码兑换';

    if (giftCode.balance_type === 'bonus') {
      balanceGrantId = `bg-${Date.now()}-${crypto
        .randomBytes(4)
        .toString('hex')}`;
      await client.query(
        `INSERT INTO balance_grants
           (id, user_id, source, granted_by, amount_coins, remaining_coins,
            note, expires_at, status, created_at, updated_at)
         VALUES ($1, $2, 'gift_code', NULL, $3, $3, $4, NULL, 'active', NOW(), NOW())`,
        [balanceGrantId, input.userId, giftCode.amount_coins, note],
      );
      const { rows: updatedRows } = await client.query(
        `UPDATE users
         SET bonus_coins = bonus_coins + $1
         WHERE id = $2
         RETURNING *`,
        [giftCode.amount_coins, input.userId],
      );
      updatedUser = normalizeUserCoins(updatedRows[0] as User);
    } else {
      const { rows: updatedRows } = await client.query(
        `UPDATE users
         SET purchased_coins = purchased_coins + $1
         WHERE id = $2
         RETURNING *`,
        [giftCode.amount_coins, input.userId],
      );
      updatedUser = normalizeUserCoins(updatedRows[0] as User);
    }

    const walletTransactionId = await insertWalletTransaction(client, {
      userId: input.userId,
      kind: 'gift_redeem',
      amountCoins: giftCode.amount_coins,
      balanceSource: giftCode.balance_type,
      balanceGrantId,
      note,
      metadata: {
        source: 'gift_code',
        giftCodeId: giftCode.id,
        giftCodeName: giftCode.name,
        usageType: giftCode.usage_type,
      },
    });

    await client.query(
      `UPDATE gift_code_redemptions
       SET wallet_transaction_id = $1,
           balance_grant_id = $2
       WHERE id = $3`,
      [walletTransactionId, balanceGrantId, redemptionId],
    );
    const { rows: updatedGiftRows } = await client.query(
      `UPDATE gift_codes
       SET redeemed_count = redeemed_count + 1,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [giftCode.id],
    );
    const { rows: finalRedemptionRows } = await client.query(
      `SELECT *
       FROM gift_code_redemptions
       WHERE id = $1`,
      [redemptionId],
    );

    await client.query('COMMIT');
    return {
      gift_code: normalizeGiftCodeRow(updatedGiftRows[0] as GiftCodeRow),
      redemption: normalizeGiftCodeRedemptionRow(
        finalRedemptionRows[0] as GiftCodeRedemptionRow,
      ),
      purchased_coins: updatedUser.purchased_coins,
      bonus_coins: updatedUser.bonus_coins,
      reserved_coins: updatedUser.reserved_coins,
      available_coins: calculateAvailableSpendableCoins(updatedUser),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 为用户创建每日签到奖励。
 *
 * 该函数在同一事务内创建签到记录、赠送积分批次、用户积分和钱包流水；
 * 如果当天已经签到，直接返回已有记录而不重复发放积分。
 */
export async function createDailySignInReward(input: {
  userId: string;
  signInDate: string;
  rewardCoins: number;
  note?: string | null;
}): Promise<{ user: User; record: DailySignInRecordRow; created: boolean }> {
  if (input.rewardCoins <= 0) {
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
         (id, user_id, sign_in_date, reward_coins, balance_grant_id, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (user_id, sign_in_date) DO NOTHING
       RETURNING *`,
      [recordId, input.userId, input.signInDate, input.rewardCoins, grantId],
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
        record: normalizeDailySignInRecordRow(
          existingRows[0] as DailySignInRecordRow,
        ),
        created: false,
      };
    }

    await client.query(
      `INSERT INTO balance_grants
         (id, user_id, source, granted_by, amount_coins, remaining_coins,
          note, expires_at, status, created_at, updated_at)
       VALUES ($1, $2, 'sign_in', NULL, $3, $3, $4, NULL, 'active', NOW(), NOW())`,
      [grantId, input.userId, input.rewardCoins, input.note ?? null],
    );

    const { rows: updatedRows } = await client.query(
      `UPDATE users
       SET bonus_coins = bonus_coins + $1
       WHERE id = $2
       RETURNING *`,
      [input.rewardCoins, input.userId],
    );

    await insertWalletTransaction(client, {
      userId: input.userId,
      kind: 'bonus_grant',
      amountCoins: input.rewardCoins,
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
      user: normalizeUserCoins(updatedRows[0] as User),
      record: normalizeDailySignInRecordRow(inserted),
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

async function getModelChargeSettlementMetadataUsing(
  client: pg.PoolClient,
  requestId: string,
): Promise<{
  rawChargeCoins?: number;
  membershipCoveredCoins?: number;
  membershipConsumedUnits?: number;
}> {
  const { rows } = await client.query(
    `SELECT metadata
     FROM wallet_transactions
     WHERE request_id = $1
       AND kind IN ('membership_allowance_use', 'overage_charge')
     ORDER BY CASE kind
       WHEN 'membership_allowance_use' THEN 0
       ELSE 1
     END,
     created_at ASC
     LIMIT 1`,
    [requestId],
  );
  const metadata = (rows[0] as { metadata?: unknown } | undefined)?.metadata;
  return {
    rawChargeCoins: numberFromMetadata(metadata, 'rawRequestCostCoins'),
    membershipCoveredCoins: numberFromMetadata(
      metadata,
      'membershipCoveredCoins',
    ),
    membershipConsumedUnits: numberFromMetadata(
      metadata,
      'membershipConsumedUnits',
    ),
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
 * 后台过期扫描入口：扫描已过期的活跃批次，批次级过期处理。
 * 每个批次在独立事务内完成：标记 expired → 扣 users.bonus_coins → 写流水。
 * FOR UPDATE SKIP LOCKED 保证多实例并发运行时不会重复处理同一批次。
 */
export async function expireBonusBalance(
  beforeIso: string,
  limit = 200,
): Promise<{ expired: number; totalCoinsExpired: number }> {
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
  let totalCoinsExpired = 0;

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
      const batch = rows[0]
        ? normalizeBalanceGrantRow(rows[0] as BalanceGrantRow)
        : undefined;
      if (!batch) {
        await client.query('COMMIT');
        continue;
      }

      const remaining = batch.remaining_coins;
      await client.query(
        `UPDATE balance_grants
         SET status = 'expired',
             remaining_coins = 0,
             updated_at = NOW()
         WHERE id = $1`,
        [batch.id],
      );

      if (remaining > 0) {
        await client.query(
          `UPDATE users
           SET bonus_coins = GREATEST(0, bonus_coins - $1)
           WHERE id = $2`,
          [remaining, batch.user_id],
        );

        await insertWalletTransaction(client, {
          userId: batch.user_id,
          kind: 'bonus_expire',
          amountCoins: -remaining,
          balanceSource: 'bonus',
          balanceGrantId: batch.id,
          note: `赠送积分过期（批次 ${batch.id}）`,
          metadata: {
            batch_source: batch.source,
            expires_at: batch.expires_at,
            original_amount: batch.amount_coins,
          },
        });
      }

      await client.query('COMMIT');
      expired += 1;
      totalCoinsExpired += remaining;
    } catch (err) {
      await client.query('ROLLBACK');
      logger.warn({ grantId, err }, '赠送积分过期处理失败');
    } finally {
      client.release();
    }
  }

  return { expired, totalCoinsExpired };
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
        membershipCoveredCoins:
          settlementMetadata.membershipCoveredCoins ?? 0,
        membershipConsumedUnits:
          settlementMetadata.membershipConsumedUnits ?? 0,
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
    const activeMemberships = await getActiveMembershipsForUserUsing(
      client,
      reservation.user_id,
      {
        forUpdate: true,
      },
    );
    const { membership: activeMembership, config: membershipConfig } =
      await resolveEffectiveMembershipUsing({
        query: client.query.bind(client),
        memberships: activeMemberships,
      });
    const membershipDeduction =
      activeMembership && membershipConfig.enabled
        ? await consumeMembershipAllowanceUsing(client, {
            userId: reservation.user_id,
            chargeCoins: rawChargeCoins,
            config: membershipConfig,
            membership: activeMembership,
          })
        : { consumedUnits: 0, coveredCoins: 0, allowance: null };
    const actualChargeCoins = roundCoinsToCents(
      Math.max(0, rawChargeCoins - membershipDeduction.coveredCoins),
    );
    const nextChargeCoins = roundCoinsToCents(
      previousChargeCoins + actualChargeCoins,
    );

    // 模型扣费不再请求前冻结余额；结束后按真实 Token 费用入账，可把充值积分扣成负数。
    const deduction = await deductModelChargeCoinsAllowDebt(
      client,
      normalizeUserCoins(user),
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
          membershipCoveredCoins: membershipDeduction.coveredCoins,
          membershipConsumedUnits: membershipDeduction.consumedUnits,
          previousChargeCoins,
          nextChargeCoins,
          bonusDeducted: deduction.bonusDeducted,
          purchasedDeducted: deduction.purchasedDeducted,
          grantDeductions: deduction.grantDeductions,
        },
      });
    }
    if (membershipDeduction.consumedUnits > 0) {
      await insertWalletTransaction(client, {
        userId: reservation.user_id,
        kind: 'membership_allowance_use',
        amountCoins: 0,
        balanceSource: null,
        requestId,
        note: '会员 AI 对话额度抵扣',
        metadata: {
          yearMonth: reservation.year_month,
          requestTokens,
          rawRequestCostCoins: rawChargeCoins,
          membershipCoveredCoins: membershipDeduction.coveredCoins,
          membershipConsumedUnits: membershipDeduction.consumedUnits,
          allowanceId: membershipDeduction.allowance?.id ?? null,
        },
      });
    }

    await client.query('COMMIT');
    return {
      actualChargeCoins,
      rawChargeCoins,
      membershipCoveredCoins: membershipDeduction.coveredCoins,
      membershipConsumedUnits: membershipDeduction.consumedUnits,
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
