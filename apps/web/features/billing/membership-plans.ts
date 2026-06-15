import type { BillingStatus } from './api';

export const MEMBERSHIP_PLUS_PLAN_KEY = 'fateclaw_plus';
export const MEMBERSHIP_PRO_PLAN_KEY = 'fateclaw_pro';

export const MEMBERSHIP_PLAN_KEYS = [
  MEMBERSHIP_PLUS_PLAN_KEY,
  MEMBERSHIP_PRO_PLAN_KEY,
] as const;

export type MembershipPlanKey = (typeof MEMBERSHIP_PLAN_KEYS)[number];

type MembershipStatus = BillingStatus['membership'];

const MEMBERSHIP_PLAN_RANKS: Record<MembershipPlanKey, number> = {
  [MEMBERSHIP_PLUS_PLAN_KEY]: 1,
  [MEMBERSHIP_PRO_PLAN_KEY]: 2,
};

/**
 * 判断传入值是否是前端已知的会员套餐 key。
 *
 * @param value 待检查字符串。
 * @returns 如果值是底层 Plus 或 Pro 套餐 key，则返回 true。
 */
export function isMembershipPlanKey(value: string): value is MembershipPlanKey {
  return (MEMBERSHIP_PLAN_KEYS as readonly string[]).includes(value);
}

/**
 * 返回套餐档位等级。
 *
 * @param planKey 套餐 key。
 * @returns 底层 Plus 为 1，Pro 为 2，未知套餐为 0。
 */
export function resolveMembershipPlanRank(planKey?: string | null): number {
  return isMembershipPlanKey(planKey ?? '')
    ? MEMBERSHIP_PLAN_RANKS[planKey as MembershipPlanKey]
    : 0;
}

/**
 * 将接口返回的套餐 key 规范化为已知套餐。
 *
 * @param planKey 接口返回或组件传入的套餐 key。
 * @returns 已知套餐 key；未知值按 Plus 兼容。
 */
export function normalizeMembershipPlanKey(
  planKey?: string | null,
): MembershipPlanKey {
  return isMembershipPlanKey(planKey ?? '')
    ? (planKey as MembershipPlanKey)
    : MEMBERSHIP_PLUS_PLAN_KEY;
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
 * @returns 会员开关开启、有效，且当前套餐达到目标档位时返回 true。
 * @remarks 历史状态缺少 plan_key 但 active=true 时，按底层 Plus 兼容。
 */
export function membershipStatusMeetsPlan(
  membership: MembershipStatus | null | undefined,
  requiredPlanKey: MembershipPlanKey,
): boolean {
  const currentPlanKey = normalizeMembershipPlanKey(membership?.plan_key);
  return Boolean(
    membership?.enabled &&
    membership.active &&
    membershipPlanMeets(currentPlanKey, requiredPlanKey),
  );
}

/**
 * 判断当前会员是否拥有现有通用会员权益。
 *
 * @param membership 账单接口返回的当前会员状态。
 * @returns Insight 及以上套餐有效时返回 true。
 */
export function hasBaseMembershipEntitlement(
  membership: MembershipStatus | null | undefined,
): boolean {
  return membershipStatusMeetsPlan(membership, MEMBERSHIP_PLUS_PLAN_KEY);
}

/**
 * 返回套餐在界面中的短名称。
 *
 * @param plan 套餐或权益片段。
 * @returns Deep 或 Insight。
 */
export function resolveMembershipPlanShortName(plan: {
  name?: string | null;
  plan_key: string;
}): 'Insight' | 'Deep' {
  if (
    plan.plan_key === MEMBERSHIP_PRO_PLAN_KEY ||
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
 * @returns FateClaw Insight 或 FateClaw Deep。
 */
export function resolveMembershipPlanDisplayName(plan: {
  name?: string | null;
  plan_key: string;
}): 'FateClaw Insight' | 'FateClaw Deep' {
  return resolveMembershipPlanShortName(plan) === 'Deep'
    ? 'FateClaw Deep'
    : 'FateClaw Insight';
}
