/**
 * 会员（卦师使用权）域跨端契约常量与基础纯函数。
 *
 * 单层化已彻底落地（迁移 0058 全量归一旧档 plan_key 为 clarity）：只有 clarity 在售。
 * 前后端唯一事实源。
 */

export declare const MEMBERSHIP_CLARITY_PLAN_KEY = 'fateclaw_clarity';

/** 当前在售套餐 key：单层卦师使用权，仅 clarity。用于可订阅校验 / ensure / 遍历。 */
export declare const ACTIVE_MEMBERSHIP_PLAN_KEYS: readonly ['fateclaw_clarity'];

/** 全部已知套餐 key：单层化后仅 clarity。 */
export declare const ALL_MEMBERSHIP_PLAN_KEYS: readonly ['fateclaw_clarity'];

export type MembershipPlanKey = (typeof ALL_MEMBERSHIP_PLAN_KEYS)[number];

export declare const MEMBERSHIP_PLAN_RANKS: Record<MembershipPlanKey, number>;

/**
 * 判断传入值是否是系统已知的会员套餐 key。
 */
export declare function isMembershipPlanKey(
  value: string,
): value is MembershipPlanKey;

/**
 * 将外部输入规范化为已知套餐 key；任何未知/旧档历史值回退到 clarity。
 */
export declare function normalizeMembershipPlanKey(
  planKey?: string | null,
  fallback?: MembershipPlanKey,
): MembershipPlanKey;

/**
 * 返回套餐档位等级；Clarity 1 / 未知 0。
 */
export declare function resolveMembershipPlanRank(
  planKey?: string | null,
): number;

/**
 * 判断当前套餐是否达到目标最低档位。
 */
export declare function membershipPlanMeets(
  currentPlanKey: string | null | undefined,
  requiredPlanKey: MembershipPlanKey,
): boolean;
