import type { BillingStatus } from './api';
import {
  MEMBERSHIP_CLARITY_PLAN_KEY,
  MEMBERSHIP_DEEP_PLAN_KEY,
  normalizeMembershipPlanKey,
  membershipPlanMeets,
} from '@fateclaw/contracts/membership';
import type { MembershipPlanKey } from '@fateclaw/contracts/membership';

/**
 * 会员（卦师使用权）套餐 key 常量、归一与档位逻辑（apps/web 侧）。
 *
 * 跨端共享的核心常量与基础纯函数统一来自 @fateclaw/contracts/membership 并经本文件
 * re-export；此处只补充前端展示特化（短名 / 完整展示名 / 基于账单状态的权益判断），
 * 避免前后端定义漂移（后端 apps/api/src/shared/membership-plans.ts 同样 re-export contracts）。
 */
export * from '@fateclaw/contracts/membership';

type MembershipStatus = BillingStatus['membership'];

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
export function hasPaidMembershipEntitlement(
  membership: MembershipStatus | null | undefined,
): boolean {
  return membershipStatusMeetsPlan(membership, MEMBERSHIP_CLARITY_PLAN_KEY);
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
