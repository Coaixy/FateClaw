/**
 * 会员（卦师使用权）域跨端运行时常量与基础纯函数（运行时实现 + 类型,单一 TS 源）。
 *
 * 单层化已彻底落地（迁移 0058 把库内残留旧档 plan_key 全量归一为 clarity）：系统只存在
 * 唯一套餐 clarity（卦师使用权）。此模块是前后端唯一事实源,避免套餐 key 常量与归一逻辑
 * 在 apps/api 与 apps/web 之间漂移。rank/meets 仍保留为权益门控原语（单层下 clarity 恒为 1）。
 */

// 唯一套餐:卦师使用权。
export const MEMBERSHIP_CLARITY_PLAN_KEY = 'fateclaw_clarity';

/**
 * 当前在售套餐 key:仅 clarity。
 * 用于可订阅校验（z.enum）、配置 ensure、套餐列表遍历——任何"在售"语义都用它。
 */
export const ACTIVE_MEMBERSHIP_PLAN_KEYS = [MEMBERSHIP_CLARITY_PLAN_KEY] as const;

/**
 * 全部已知套餐 key:单层化后仅 clarity（旧档 insight/deep/plus/pro 已由迁移 0058 全量归一）。
 */
export const ALL_MEMBERSHIP_PLAN_KEYS = [MEMBERSHIP_CLARITY_PLAN_KEY] as const;

export type MembershipPlanKey = (typeof ALL_MEMBERSHIP_PLAN_KEYS)[number];

/**
 * 档位等级:单层下 clarity 恒为 1。保留 rank 概念作为权益门控原语（>= 比较即"是否有效付费会员"）。
 */
export const MEMBERSHIP_PLAN_RANKS: Record<MembershipPlanKey, number> = {
  [MEMBERSHIP_CLARITY_PLAN_KEY]: 1,
};

/**
 * 判断传入值是否是系统已知的会员套餐 key。
 *
 * @param value 待检查字符串。
 * @returns 值为 clarity 时返回 true。
 */
export function isMembershipPlanKey(value: string): value is MembershipPlanKey {
  return (ALL_MEMBERSHIP_PLAN_KEYS as readonly string[]).includes(value);
}

/**
 * 将外部输入规范化为已知套餐 key。
 *
 * @param planKey 外部传入的套餐 key,可空或未知（含已归一的旧档历史值）。
 * @param fallback 未知或空值时的回退套餐,默认回落到 clarity。
 * @returns 已知套餐 key（任何非 clarity 的历史值都回落到 clarity）。
 */
export function normalizeMembershipPlanKey(
  planKey?: string | null,
  fallback: MembershipPlanKey = MEMBERSHIP_CLARITY_PLAN_KEY,
): MembershipPlanKey {
  return isMembershipPlanKey(planKey ?? '')
    ? (planKey as MembershipPlanKey)
    : fallback;
}

/**
 * 返回套餐档位等级。
 *
 * @param planKey 套餐 key。
 * @returns Clarity 为 1,未知为 0。
 */
export function resolveMembershipPlanRank(planKey?: string | null): number {
  if (!planKey || !isMembershipPlanKey(planKey)) return 0;
  return MEMBERSHIP_PLAN_RANKS[planKey];
}

/**
 * 判断当前套餐是否达到目标最低档位。
 *
 * @param currentPlanKey 当前实际生效的套餐 key。
 * @param requiredPlanKey 目标最低套餐档位。
 * @returns 当前档位 >= 目标档位时返回 true。
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
