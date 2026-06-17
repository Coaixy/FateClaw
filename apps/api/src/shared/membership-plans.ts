export const MEMBERSHIP_CLARITY_PLAN_KEY = 'fateclaw_clarity';
export const MEMBERSHIP_INSIGHT_PLAN_KEY = 'fateclaw_insight';
export const MEMBERSHIP_DEEP_PLAN_KEY = 'fateclaw_deep';

/** @deprecated 仅用于识别迁移前的 Insight 旧 key。 */
export const MEMBERSHIP_PLUS_PLAN_KEY = 'fateclaw_plus';
/** @deprecated 仅用于识别迁移前的 Deep 旧 key。 */
export const MEMBERSHIP_PRO_PLAN_KEY = 'fateclaw_pro';
/** @deprecated 仅用于识别迁移前的 Insight 配置行。 */
export const MEMBERSHIP_PLUS_CONFIG_ID = 'default';

export const MEMBERSHIP_PLAN_KEYS = [
  MEMBERSHIP_CLARITY_PLAN_KEY,
  MEMBERSHIP_INSIGHT_PLAN_KEY,
  MEMBERSHIP_DEEP_PLAN_KEY,
] as const;

export type MembershipPlanKey = (typeof MEMBERSHIP_PLAN_KEYS)[number];

const MEMBERSHIP_PLAN_RANKS: Record<MembershipPlanKey, number> = {
  [MEMBERSHIP_CLARITY_PLAN_KEY]: 1,
  [MEMBERSHIP_INSIGHT_PLAN_KEY]: 2,
  [MEMBERSHIP_DEEP_PLAN_KEY]: 3,
};

const LEGACY_MEMBERSHIP_PLAN_KEY_MAP: Record<string, MembershipPlanKey> = {
  [MEMBERSHIP_PLUS_PLAN_KEY]: MEMBERSHIP_INSIGHT_PLAN_KEY,
  [MEMBERSHIP_PRO_PLAN_KEY]: MEMBERSHIP_DEEP_PLAN_KEY,
};

/**
 * 判断传入值是否是当前系统支持的会员套餐 key。
 *
 * @param value 待检查的字符串。
 * @returns 如果值是 Clarity、Insight 或 Deep 套餐 key，则返回 true。
 */
export function isMembershipPlanKey(value: string): value is MembershipPlanKey {
  return (MEMBERSHIP_PLAN_KEYS as readonly string[]).includes(value);
}

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
 * 将外部输入规范化为已知套餐 key。
 *
 * @param planKey 外部传入的套餐 key，可以为空或未知。
 * @param fallback 未知或空值时使用的回退套餐，默认回落到最低付费档 Clarity。
 * @returns 已知套餐 key；旧 Plus/Pro 会映射到 Insight/Deep。
 */
export function normalizeMembershipPlanKey(
  planKey?: string | null,
  fallback: MembershipPlanKey = MEMBERSHIP_CLARITY_PLAN_KEY,
): MembershipPlanKey {
  if (isMembershipPlanKey(planKey ?? '')) {
    return planKey as MembershipPlanKey;
  }
  const legacy = LEGACY_MEMBERSHIP_PLAN_KEY_MAP[planKey ?? ''];
  return legacy ?? fallback;
}

/**
 * 根据套餐 key 解析 membership_config 表中的配置 ID。
 *
 * @param planKey 套餐 key。
 * @returns 新版三档套餐直接使用自身 key；旧 key 会先映射到新 key。
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
 * 返回套餐档位等级。
 *
 * @param planKey 套餐 key。
 * @returns Clarity 为 1，Insight 为 2，Deep 为 3，未知套餐为 0。
 */
export function resolveMembershipPlanRank(planKey?: string | null): number {
  if (!planKey) return 0;
  const normalizedPlanKey = isMembershipPlanKey(planKey)
    ? planKey
    : LEGACY_MEMBERSHIP_PLAN_KEY_MAP[planKey];
  return normalizedPlanKey ? MEMBERSHIP_PLAN_RANKS[normalizedPlanKey] : 0;
}

/**
 * 判断当前套餐是否达到目标档位。
 *
 * @param currentPlanKey 当前实际生效的套餐 key。
 * @param requiredPlanKey 目标最低套餐档位。
 * @returns 当前套餐等级大于等于目标套餐等级时返回 true。
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
 * @deprecated 仅作为旧命名兼容 wrapper，新代码使用 hasPaidMembershipEntitlement()。
 */
export function hasBaseMembershipEntitlement(
  membership: {
    active: boolean;
    membership: { plan_key: string | null } | null;
  } | null,
): boolean {
  return hasPaidMembershipEntitlement(membership);
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
 * 判断当前会员是否可使用专家模式。
 *
 * @param membership 当前会员概览。
 * @returns Clarity 及以上套餐有效时返回 true。
 */
export function hasExpertModeEntitlement(
  membership: {
    active: boolean;
    membership: { plan_key: string | null } | null;
  } | null,
): boolean {
  return membershipOverviewMeetsPlan(membership, MEMBERSHIP_CLARITY_PLAN_KEY);
}

/**
 * 判断当前会员是否进入 runtime 会员优先队列。
 *
 * @param membership 当前会员概览。
 * @returns Insight 及以上套餐有效时返回 true。
 */
export function hasPriorityQueueEntitlement(
  membership: {
    active: boolean;
    membership: { plan_key: string | null } | null;
  } | null,
): boolean {
  return membershipOverviewMeetsPlan(membership, MEMBERSHIP_INSIGHT_PLAN_KEY);
}

/**
 * 判断当前会员是否可使用自定义模型。
 *
 * @param membership 当前会员概览。
 * @returns Insight 及以上套餐有效时返回 true。
 */
export function hasCustomModelEntitlement(
  membership: {
    active: boolean;
    membership: { plan_key: string | null } | null;
  } | null,
): boolean {
  return membershipOverviewMeetsPlan(membership, MEMBERSHIP_INSIGHT_PLAN_KEY);
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

/**
 * 解析套餐对应的专家 AI 每日可用次数。
 *
 * @param planKey 当前套餐 key；为空或未知时按 Free 处理。
 * @returns Free 为 0，Clarity 为 10，Insight 为 30，Deep 为 100。
 */
export function resolveProfessionalAiDailyTurnLimit(
  planKey?: string | null,
): number {
  const rank = resolveMembershipPlanRank(planKey);
  if (rank >= MEMBERSHIP_PLAN_RANKS[MEMBERSHIP_DEEP_PLAN_KEY]) return 100;
  if (rank >= MEMBERSHIP_PLAN_RANKS[MEMBERSHIP_INSIGHT_PLAN_KEY]) return 30;
  if (rank >= MEMBERSHIP_PLAN_RANKS[MEMBERSHIP_CLARITY_PLAN_KEY]) return 10;
  return 0;
}
