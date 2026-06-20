/**
 * 会员（卦师使用权）域跨端契约常量与基础纯函数。
 *
 * 单层化后只有 clarity 在售；insight/deep 仅用于识别存量历史会员。前后端唯一事实源。
 */

export declare const MEMBERSHIP_CLARITY_PLAN_KEY = 'fateclaw_clarity';
export declare const MEMBERSHIP_INSIGHT_PLAN_KEY = 'fateclaw_insight';
export declare const MEMBERSHIP_DEEP_PLAN_KEY = 'fateclaw_deep';
export declare const MEMBERSHIP_PLUS_PLAN_KEY = 'fateclaw_plus';
export declare const MEMBERSHIP_PRO_PLAN_KEY = 'fateclaw_pro';

/** 当前在售套餐 key：单层卦师使用权，仅 clarity。用于可订阅校验 / ensure / 遍历。 */
export declare const ACTIVE_MEMBERSHIP_PLAN_KEYS: readonly ['fateclaw_clarity'];

/** 全部新三档 key（含已停售）：仅用于识别 / 归一存量会员历史档位。 */
export declare const ALL_MEMBERSHIP_PLAN_KEYS: readonly [
  'fateclaw_clarity',
  'fateclaw_insight',
  'fateclaw_deep',
];

export type MembershipPlanKey = (typeof ALL_MEMBERSHIP_PLAN_KEYS)[number];

export declare const MEMBERSHIP_PLAN_RANKS: Record<MembershipPlanKey, number>;

export declare const LEGACY_MEMBERSHIP_PLAN_KEY_MAP: Record<
  string,
  MembershipPlanKey
>;

/**
 * 判断传入值是否是系统已知的会员套餐 key（含已停售旧档，用于历史识别）。
 */
export declare function isMembershipPlanKey(
  value: string,
): value is MembershipPlanKey;

/**
 * 将外部输入规范化为已知套餐 key；旧 Plus/Pro 映射到 Insight/Deep，未知回退到 clarity。
 */
export declare function normalizeMembershipPlanKey(
  planKey?: string | null,
  fallback?: MembershipPlanKey,
): MembershipPlanKey;

/**
 * 返回套餐档位等级；Clarity 1 / Insight 2 / Deep 3 / 未知 0。
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
