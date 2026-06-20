import type { BillingStatus } from './api';
import {
  MEMBERSHIP_CLARITY_PLAN_KEY,
  normalizeMembershipPlanKey,
  membershipPlanMeets,
} from '@fateclaw/contracts/membership';
import type { MembershipPlanKey } from '@fateclaw/contracts/membership';

/**
 * 会员（卦师使用权）套餐 key 常量、归一与档位逻辑（apps/web 侧）。
 *
 * 跨端共享的核心常量与基础纯函数统一来自 @fateclaw/contracts/membership 并经本文件
 * re-export；此处只补充前端展示特化（展示名 / 基于账单状态的权益判断），
 * 避免前后端定义漂移（后端 apps/api/src/shared/membership-plans.ts 同样 re-export contracts）。
 *
 * 单层化后只有 clarity（卦师使用权）：已删除 insight/deep/plus/pro 旧档常量与 LEGACY 映射。
 */
// turbopack 无法解析对预编译 workspace 包（@fateclaw/contracts，仅 .js+.d.ts）的 `export *`
// 星号透传——它会把本模块的透传导出静态枚举为 0 个，导致下游 import 的 normalizeMembershipPlanKey
// 等被误判为「不存在」。改为显式具名 re-export（按名透传，与可用的具名 import 走同一解析路径）。
export {
  MEMBERSHIP_CLARITY_PLAN_KEY,
  ACTIVE_MEMBERSHIP_PLAN_KEYS,
  ALL_MEMBERSHIP_PLAN_KEYS,
  MEMBERSHIP_PLAN_RANKS,
  isMembershipPlanKey,
  normalizeMembershipPlanKey,
  resolveMembershipPlanRank,
  membershipPlanMeets,
} from '@fateclaw/contracts/membership';
export type { MembershipPlanKey } from '@fateclaw/contracts/membership';

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
 * 判断当前会员是否拥有付费会员基础身份（有效的卦师使用权）。
 *
 * @param membership 账单接口返回的当前会员状态。
 * @returns Clarity 有效时返回 true。
 */
export function hasPaidMembershipEntitlement(
  membership: MembershipStatus | null | undefined,
): boolean {
  return membershipStatusMeetsPlan(membership, MEMBERSHIP_CLARITY_PLAN_KEY);
}

/**
 * 返回套餐在界面中的完整展示名（兜底用，正式名以后端 membership_config.name「卦师使用权」为准）。
 *
 * @param _plan 套餐或权益片段（单层化后无分支，仅保留签名兼容调用方）。
 * @returns FateClaw Clarity。
 */
export function resolveMembershipPlanDisplayName(_plan: {
  name?: string | null;
  plan_key: string;
}): 'FateClaw Clarity' {
  return 'FateClaw Clarity';
}
