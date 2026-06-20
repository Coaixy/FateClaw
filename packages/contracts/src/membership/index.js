/**
 * 会员（卦师使用权）域跨端运行时常量与基础纯函数。
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
export const ACTIVE_MEMBERSHIP_PLAN_KEYS = [MEMBERSHIP_CLARITY_PLAN_KEY];

/**
 * 全部已知套餐 key:单层化后仅 clarity（旧档 insight/deep/plus/pro 已由迁移 0058 全量归一）。
 */
export const ALL_MEMBERSHIP_PLAN_KEYS = [MEMBERSHIP_CLARITY_PLAN_KEY];

/**
 * 档位等级:单层下 clarity 恒为 1。保留 rank 概念作为权益门控原语（>= 比较即"是否有效付费会员"）。
 */
export const MEMBERSHIP_PLAN_RANKS = {
  [MEMBERSHIP_CLARITY_PLAN_KEY]: 1,
};

/**
 * 判断传入值是否是系统已知的会员套餐 key。
 *
 * @param {string} value 待检查字符串。
 * @returns {boolean} 值为 clarity 时返回 true。
 */
export function isMembershipPlanKey(value) {
  return ALL_MEMBERSHIP_PLAN_KEYS.includes(value);
}

/**
 * 将外部输入规范化为已知套餐 key。
 *
 * @param {string | null | undefined} planKey 外部传入的套餐 key，可空或未知（含已归一的旧档历史值）。
 * @param {string} [fallback] 未知或空值时的回退套餐，默认回落到 clarity。
 * @returns {string} 已知套餐 key（任何非 clarity 的历史值都回落到 clarity）。
 */
export function normalizeMembershipPlanKey(
  planKey,
  fallback = MEMBERSHIP_CLARITY_PLAN_KEY,
) {
  return isMembershipPlanKey(planKey ?? '') ? planKey : fallback;
}

/**
 * 返回套餐档位等级。
 *
 * @param {string | null | undefined} planKey 套餐 key。
 * @returns {number} Clarity 为 1，未知为 0。
 */
export function resolveMembershipPlanRank(planKey) {
  if (!planKey || !isMembershipPlanKey(planKey)) return 0;
  return MEMBERSHIP_PLAN_RANKS[planKey];
}

/**
 * 判断当前套餐是否达到目标最低档位。
 *
 * @param {string | null | undefined} currentPlanKey 当前实际生效的套餐 key。
 * @param {string} requiredPlanKey 目标最低套餐档位。
 * @returns {boolean} 当前档位 >= 目标档位时返回 true。
 */
export function membershipPlanMeets(currentPlanKey, requiredPlanKey) {
  return (
    resolveMembershipPlanRank(currentPlanKey) >=
    resolveMembershipPlanRank(requiredPlanKey)
  );
}
