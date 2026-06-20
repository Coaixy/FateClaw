/**
 * 会员（卦师使用权）套餐 key 常量、归一与档位逻辑（apps/api 侧）。
 *
 * 跨端共享的核心常量与基础纯函数统一来自 @fateclaw/contracts/membership 并经本文件
 * re-export；此处只补充 apps/api 侧特有的 membership_config 行解析与会员概览权益判断，
 * 避免前后端定义漂移（前端 apps/web/features/billing/membership-plans.ts 同样 re-export contracts）。
 *
 * 单层化已彻底落地（迁移 0058 全量归一旧档 plan_key 为 clarity）：只有 clarity 在售，
 * 历史识别/归一逻辑已从 contracts 收敛为"非 clarity 即回落 clarity"。
 */
export * from '@fateclaw/contracts/membership';

import {
  MEMBERSHIP_CLARITY_PLAN_KEY,
  normalizeMembershipPlanKey,
  membershipPlanMeets,
} from '@fateclaw/contracts/membership';
import type { MembershipPlanKey } from '@fateclaw/contracts/membership';

/**
 * 根据套餐 key 解析 membership_config 表中的配置 ID。
 *
 * @param planKey 套餐 key。
 * @returns 单层化后恒为 clarity；任何历史旧值都归一到 clarity。
 */
export function resolveMembershipConfigId(planKey: string): string {
  return normalizeMembershipPlanKey(planKey);
}

/**
 * 根据配置 ID 反解套餐 key。
 *
 * @param configId membership_config.id。
 * @returns 单层化后恒为 clarity；任何历史旧 id 都归一到 clarity。
 */
export function resolveMembershipPlanKey(configId: string): MembershipPlanKey {
  return normalizeMembershipPlanKey(configId);
}

/**
 * 返回套餐的默认展示名称（兜底用，正式名以 membership_config.name 为准）。
 *
 * @param _planKey 套餐 key（单层化后无分支，仅保留签名兼容调用方）。
 * @returns FateClaw Clarity。
 */
export function resolveMembershipPlanName(_planKey: string): string {
  return 'FateClaw Clarity';
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
 * 判断当前会员是否拥有付费会员基础身份（有效的卦师使用权）。
 *
 * @param membership 当前会员概览。
 * @returns Clarity 有效时返回 true。
 */
export function hasPaidMembershipEntitlement(
  membership: {
    active: boolean;
    membership: { plan_key: string | null } | null;
  } | null,
): boolean {
  return membershipOverviewMeetsPlan(membership, MEMBERSHIP_CLARITY_PLAN_KEY);
}
