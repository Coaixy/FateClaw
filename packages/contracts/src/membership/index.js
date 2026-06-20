/**
 * 会员（卦师使用权）域跨端运行时常量与基础纯函数。
 *
 * 单层化后只有 clarity（卦师使用权）在售；insight/deep 仅用于识别存量历史会员，
 * 更早的 plus/pro 是迁移前遗留 key。此模块是前后端唯一事实源，避免套餐 key 常量
 * 与归一逻辑在 apps/api 与 apps/web 之间漂移。
 */

// 唯一在售套餐：卦师使用权。
export const MEMBERSHIP_CLARITY_PLAN_KEY = 'fateclaw_clarity';
// 已停售旧档，仅用于识别 / 归一存量会员的历史 plan_key。
export const MEMBERSHIP_INSIGHT_PLAN_KEY = 'fateclaw_insight';
export const MEMBERSHIP_DEEP_PLAN_KEY = 'fateclaw_deep';
// 更早期的遗留 key（迁移前的 Plus / Pro），只用于识别老数据。
export const MEMBERSHIP_PLUS_PLAN_KEY = 'fateclaw_plus';
export const MEMBERSHIP_PRO_PLAN_KEY = 'fateclaw_pro';

/**
 * 当前在售套餐 key：单层卦师使用权，仅 clarity。
 * 用于可订阅校验（z.enum）、配置 ensure、套餐列表遍历——任何"在售"语义都用它。
 */
export const ACTIVE_MEMBERSHIP_PLAN_KEYS = [MEMBERSHIP_CLARITY_PLAN_KEY];

/**
 * 全部"新三档"key（含已停售）：仅用于识别 / 归一存量会员的历史档位，不代表在售。
 * 存量会员的 plan_key 可能仍是 insight/deep，故识别类逻辑必须认这三档。
 */
export const ALL_MEMBERSHIP_PLAN_KEYS = [
  MEMBERSHIP_CLARITY_PLAN_KEY,
  MEMBERSHIP_INSIGHT_PLAN_KEY,
  MEMBERSHIP_DEEP_PLAN_KEY,
];

/**
 * 档位等级：仅用于对存量旧档会员排序 / 比较；单层后新用户均为 clarity(1)。
 */
export const MEMBERSHIP_PLAN_RANKS = {
  [MEMBERSHIP_CLARITY_PLAN_KEY]: 1,
  [MEMBERSHIP_INSIGHT_PLAN_KEY]: 2,
  [MEMBERSHIP_DEEP_PLAN_KEY]: 3,
};

/**
 * 迁移前遗留 key → 新三档 key 的映射，用于识别存量历史会员。
 */
export const LEGACY_MEMBERSHIP_PLAN_KEY_MAP = {
  [MEMBERSHIP_PLUS_PLAN_KEY]: MEMBERSHIP_INSIGHT_PLAN_KEY,
  [MEMBERSHIP_PRO_PLAN_KEY]: MEMBERSHIP_DEEP_PLAN_KEY,
};

/**
 * 判断传入值是否是系统已知的会员套餐 key（含已停售旧档，用于历史识别）。
 *
 * @param {string} value 待检查字符串。
 * @returns {boolean} 值是 clarity / insight / deep 之一时返回 true。
 */
export function isMembershipPlanKey(value) {
  return ALL_MEMBERSHIP_PLAN_KEYS.includes(value);
}

/**
 * 将外部输入规范化为已知套餐 key。
 *
 * @param {string | null | undefined} planKey 外部传入的套餐 key，可空或未知。
 * @param {string} [fallback] 未知或空值时的回退套餐，默认回落到 clarity。
 * @returns {string} 已知套餐 key；旧 Plus/Pro 会映射到 Insight/Deep。
 */
export function normalizeMembershipPlanKey(
  planKey,
  fallback = MEMBERSHIP_CLARITY_PLAN_KEY,
) {
  if (isMembershipPlanKey(planKey ?? '')) {
    return planKey;
  }
  const legacy = LEGACY_MEMBERSHIP_PLAN_KEY_MAP[planKey ?? ''];
  return legacy ?? fallback;
}

/**
 * 返回套餐档位等级。
 *
 * @param {string | null | undefined} planKey 套餐 key。
 * @returns {number} Clarity 为 1，Insight 为 2，Deep 为 3，未知为 0。
 */
export function resolveMembershipPlanRank(planKey) {
  if (!planKey) return 0;
  const normalizedPlanKey = isMembershipPlanKey(planKey)
    ? planKey
    : LEGACY_MEMBERSHIP_PLAN_KEY_MAP[planKey];
  return normalizedPlanKey ? MEMBERSHIP_PLAN_RANKS[normalizedPlanKey] : 0;
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
