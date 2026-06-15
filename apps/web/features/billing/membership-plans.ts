import type { BillingStatus } from './api';

export const MEMBERSHIP_CLARITY_PLAN_KEY = 'fateclaw_clarity';
export const MEMBERSHIP_INSIGHT_PLAN_KEY = 'fateclaw_insight';
export const MEMBERSHIP_DEEP_PLAN_KEY = 'fateclaw_deep';

/** @deprecated 仅用于识别迁移前的 Insight 旧 key。 */
export const MEMBERSHIP_PLUS_PLAN_KEY = 'fateclaw_plus';
/** @deprecated 仅用于识别迁移前的 Deep 旧 key。 */
export const MEMBERSHIP_PRO_PLAN_KEY = 'fateclaw_pro';

export const MEMBERSHIP_PLAN_KEYS = [
  MEMBERSHIP_CLARITY_PLAN_KEY,
  MEMBERSHIP_INSIGHT_PLAN_KEY,
  MEMBERSHIP_DEEP_PLAN_KEY,
] as const;

export type MembershipPlanKey = (typeof MEMBERSHIP_PLAN_KEYS)[number];

type MembershipStatus = BillingStatus['membership'];

const MEMBERSHIP_PLAN_RANKS: Record<MembershipPlanKey, number> = {
  [MEMBERSHIP_CLARITY_PLAN_KEY]: 1,
  [MEMBERSHIP_INSIGHT_PLAN_KEY]: 2,
  [MEMBERSHIP_DEEP_PLAN_KEY]: 3,
};

const LEGACY_MEMBERSHIP_PLAN_KEY_MAP: Record<string, MembershipPlanKey> = {
  [MEMBERSHIP_PLUS_PLAN_KEY]: MEMBERSHIP_INSIGHT_PLAN_KEY,
  [MEMBERSHIP_PRO_PLAN_KEY]: MEMBERSHIP_DEEP_PLAN_KEY,
};

/**
 * 判断传入值是否是前端已知的会员套餐 key。
 *
 * @param value 待检查字符串。
 * @returns 如果值是 Clarity、Insight 或 Deep 套餐 key，则返回 true。
 */
export function isMembershipPlanKey(value: string): value is MembershipPlanKey {
  return (MEMBERSHIP_PLAN_KEYS as readonly string[]).includes(value);
}

/**
 * 返回套餐档位等级。
 *
 * @param planKey 套餐 key。
 * @returns Clarity 为 1，Insight 为 2，Deep 为 3，未知套餐为 0。
 */
export function resolveMembershipPlanRank(planKey?: string | null): number {
  if (!planKey) return 0;
  const normalizedPlanKey = isMembershipPlanKey(planKey)
    ? planKey
    : LEGACY_MEMBERSHIP_PLAN_KEY_MAP[planKey];
  return normalizedPlanKey ? MEMBERSHIP_PLAN_RANKS[normalizedPlanKey] : 0;
}

/**
 * 将接口返回的套餐 key 规范化为已知套餐。
 *
 * @param planKey 接口返回或组件传入的套餐 key。
 * @param fallback 未知或空值时使用的回退套餐，默认回落到最低付费档 Clarity。
 * @returns 已知套餐 key；旧 Plus/Pro 会映射到 Insight/Deep。
 */
export function normalizeMembershipPlanKey(
  planKey?: string | null,
  fallback: MembershipPlanKey = MEMBERSHIP_CLARITY_PLAN_KEY,
): MembershipPlanKey {
  if (isMembershipPlanKey(planKey ?? '')) {
    return planKey as MembershipPlanKey;
  }
  return LEGACY_MEMBERSHIP_PLAN_KEY_MAP[planKey ?? ''] ?? fallback;
}

/**
 * 判断当前套餐是否达到指定最低档位。
 *
 * @param currentPlanKey 当前生效套餐 key。
 * @param requiredPlanKey 目标最低套餐档位。
 * @returns 当前档位大于等于目标档位时返回 true。
 */
export function membershipPlanMeets(
  currentPlanKey: string | null | undefined,
  requiredPlanKey: MembershipPlanKey,
): boolean {
  return (
    resolveMembershipPlanRank(currentPlanKey) >=
    resolveMembershipPlanRank(requiredPlanKey)
  );
}

/**
 * 判断会员状态是否拥有指定最低档位。
 *
 * @param membership 账单接口返回的当前会员状态。
 * @param requiredPlanKey 目标最低套餐档位。
 * @returns 当前会员周期有效，且当前套餐达到目标档位时返回 true。
 */
export function membershipStatusMeetsPlan(
  membership: MembershipStatus | null | undefined,
  requiredPlanKey: MembershipPlanKey,
): boolean {
  if (!membership?.active || !membership.plan_key) {
    return false;
  }
  const currentPlanKey = normalizeMembershipPlanKey(membership.plan_key);
  return membershipPlanMeets(currentPlanKey, requiredPlanKey);
}

/**
 * 判断当前会员是否拥有付费会员基础身份。
 *
 * @param membership 账单接口返回的当前会员状态。
 * @returns Clarity 及以上套餐有效时返回 true。
 */
export function hasBaseMembershipEntitlement(
  membership: MembershipStatus | null | undefined,
): boolean {
  return hasPaidMembershipEntitlement(membership);
}

/**
 * 判断当前会员是否拥有付费会员基础身份。
 *
 * @param membership 账单接口返回的当前会员状态。
 * @returns Clarity 及以上套餐有效时返回 true。
 */
export function hasPaidMembershipEntitlement(
  membership: MembershipStatus | null | undefined,
): boolean {
  return membershipStatusMeetsPlan(membership, MEMBERSHIP_CLARITY_PLAN_KEY);
}

/**
 * 判断当前会员是否进入 runtime 会员优先队列。
 *
 * @param membership 账单接口返回的当前会员状态。
 * @returns Insight 及以上套餐有效时返回 true。
 */
export function hasPriorityQueueEntitlement(
  membership: MembershipStatus | null | undefined,
): boolean {
  return membershipStatusMeetsPlan(membership, MEMBERSHIP_INSIGHT_PLAN_KEY);
}

/**
 * 判断当前会员是否可使用自定义模型。
 *
 * @param membership 账单接口返回的当前会员状态。
 * @returns Insight 及以上套餐有效时返回 true。
 */
export function hasCustomModelEntitlement(
  membership: MembershipStatus | null | undefined,
): boolean {
  return membershipStatusMeetsPlan(membership, MEMBERSHIP_INSIGHT_PLAN_KEY);
}

/**
 * 判断当前会员是否可使用微信 Claw。
 *
 * @param membership 账单接口返回的当前会员状态。
 * @returns Deep 套餐有效时返回 true。
 */
export function hasWechatClawEntitlement(
  membership: MembershipStatus | null | undefined,
): boolean {
  return membershipStatusMeetsPlan(membership, MEMBERSHIP_DEEP_PLAN_KEY);
}

/**
 * 返回套餐在界面中的短名称。
 *
 * @param plan 套餐或权益片段。
 * @returns Clarity、Insight 或 Deep。
 */
export function resolveMembershipPlanShortName(plan: {
  name?: string | null;
  plan_key: string;
}): 'Clarity' | 'Insight' | 'Deep' {
  const normalizedPlanKey = normalizeMembershipPlanKey(plan.plan_key);
  if (normalizedPlanKey === MEMBERSHIP_CLARITY_PLAN_KEY) {
    return 'Clarity';
  }
  if (
    normalizedPlanKey === MEMBERSHIP_DEEP_PLAN_KEY ||
    /pro|deep/i.test(plan.name ?? '')
  ) {
    return 'Deep';
  }
  return 'Insight';
}

/**
 * 返回套餐在界面中的完整展示名。
 *
 * @param plan 套餐或权益片段。
 * @returns FateClaw Clarity、FateClaw Insight 或 FateClaw Deep。
 */
export function resolveMembershipPlanDisplayName(plan: {
  name?: string | null;
  plan_key: string;
}): 'FateClaw Clarity' | 'FateClaw Insight' | 'FateClaw Deep' {
  const shortName = resolveMembershipPlanShortName(plan);
  if (shortName === 'Deep') return 'FateClaw Deep';
  if (shortName === 'Insight') return 'FateClaw Insight';
  return 'FateClaw Clarity';
}

/**
 * 解析套餐对应的专家 AI 每日可用次数。
 *
 * @param planKey 当前套餐 key；为空或未知时按 Free 处理。
 * @returns Free 为 0，Clarity 为 10，Insight 为 30，Deep 为 100。
 */
export function resolveProfessionalAiDailyTurnLimit(
  planKey?: string | null,
): number {
  const rank = resolveMembershipPlanRank(planKey);
  if (rank >= MEMBERSHIP_PLAN_RANKS[MEMBERSHIP_DEEP_PLAN_KEY]) return 100;
  if (rank >= MEMBERSHIP_PLAN_RANKS[MEMBERSHIP_INSIGHT_PLAN_KEY]) return 30;
  if (rank >= MEMBERSHIP_PLAN_RANKS[MEMBERSHIP_CLARITY_PLAN_KEY]) return 10;
  return 0;
}
