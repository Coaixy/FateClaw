/**
 * 会员（卦师使用权）套餐 key 常量、归一与档位逻辑（apps/api 侧）。
 *
 * 跨端共享的核心常量与基础纯函数统一来自 @fateclaw/contracts/membership 并经本文件
 * re-export；此处只补充 apps/api 侧特有的 membership_config 行解析与会员概览权益判断，
 * 避免前后端定义漂移（前端 apps/web/features/billing/membership-plans.ts 同样 re-export contracts）。
 */
export * from '@fateclaw/contracts/membership';

import {
  MEMBERSHIP_CLARITY_PLAN_KEY,
  MEMBERSHIP_INSIGHT_PLAN_KEY,
  MEMBERSHIP_DEEP_PLAN_KEY,
  LEGACY_MEMBERSHIP_PLAN_KEY_MAP,
  normalizeMembershipPlanKey,
  membershipPlanMeets,
} from '@fateclaw/contracts/membership';
import type { MembershipPlanKey } from '@fateclaw/contracts/membership';

/** @deprecated 仅用于识别迁移前的 Insight 配置行（membership_config.id = 'default'）。 */
export const MEMBERSHIP_PLUS_CONFIG_ID = 'default';

/**
 * 判断传入值是否是迁移前遗留的会员套餐 key。
 *
 * @param value 待检查的字符串。
 * @returns 如果值是旧 Plus 或 Pro key，则返回 true。
 */
export function isLegacyMembershipPlanKey(value: string): boolean {
  return Object.prototype.hasOwnProperty.call(
    LEGACY_MEMBERSHIP_PLAN_KEY_MAP,
    value,
  );
}

/**
 * 根据套餐 key 解析 membership_config 表中的配置 ID。
 *
 * @param planKey 套餐 key。
 * @returns 新版套餐直接使用自身 key；旧 key 会先映射到新 key。
 */
export function resolveMembershipConfigId(planKey: string): string {
  return normalizeMembershipPlanKey(planKey);
}

/**
 * 根据配置 ID 反解套餐 key。
 *
 * @param configId membership_config.id。
 * @returns 已知套餐 key；旧 default/Pro 配置会映射到 Insight/Deep。
 */
export function resolveMembershipPlanKey(configId: string): MembershipPlanKey {
  if (configId === MEMBERSHIP_PLUS_CONFIG_ID) {
    return MEMBERSHIP_INSIGHT_PLAN_KEY;
  }
  return normalizeMembershipPlanKey(configId);
}

/**
 * 返回套餐的默认展示名称。
 *
 * @param planKey 套餐 key。
 * @returns FateClaw Clarity、FateClaw Insight 或 FateClaw Deep。
 */
export function resolveMembershipPlanName(planKey: string): string {
  switch (normalizeMembershipPlanKey(planKey)) {
    case MEMBERSHIP_DEEP_PLAN_KEY:
      return 'FateClaw Deep';
    case MEMBERSHIP_INSIGHT_PLAN_KEY:
      return 'FateClaw Insight';
    case MEMBERSHIP_CLARITY_PLAN_KEY:
    default:
      return 'FateClaw Clarity';
  }
}

/**
 * 判断会员概览是否拥有指定最低档位。
 *
 * @param membership 当前会员概览，至少包含 active 与 membership.plan_key。
 * @param requiredPlanKey 目标最低套餐档位。
 * @returns 会员有效且当前套餐达到目标档位时返回 true。
 */
export function membershipOverviewMeetsPlan(
  membership: {
    active: boolean;
    membership: { plan_key: string | null } | null;
  } | null,
  requiredPlanKey: MembershipPlanKey,
): boolean {
  if (!membership?.active || !membership.membership?.plan_key) {
    return false;
  }
  const currentPlanKey = normalizeMembershipPlanKey(
    membership.membership.plan_key,
  );
  return membershipPlanMeets(currentPlanKey, requiredPlanKey);
}

/**
 * 判断当前会员是否拥有付费会员基础身份。
 *
 * @param membership 当前会员概览。
 * @returns Clarity 及以上套餐有效时返回 true。
 */
export function hasPaidMembershipEntitlement(
  membership: {
    active: boolean;
    membership: { plan_key: string | null } | null;
  } | null,
): boolean {
  return membershipOverviewMeetsPlan(membership, MEMBERSHIP_CLARITY_PLAN_KEY);
}

/**
 * 判断当前会员是否可使用微信 Claw。
 *
 * @param membership 当前会员概览。
 * @returns Deep 套餐有效时返回 true。
 */
export function hasWechatClawEntitlement(
  membership: {
    active: boolean;
    membership: { plan_key: string | null } | null;
  } | null,
): boolean {
  return membershipOverviewMeetsPlan(membership, MEMBERSHIP_DEEP_PLAN_KEY);
}
