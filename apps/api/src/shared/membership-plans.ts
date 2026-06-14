export const MEMBERSHIP_PLUS_PLAN_KEY = 'fateclaw_plus';
export const MEMBERSHIP_PRO_PLAN_KEY = 'fateclaw_pro';
export const MEMBERSHIP_PLUS_CONFIG_ID = 'default';

export const MEMBERSHIP_PLAN_KEYS = [
  MEMBERSHIP_PLUS_PLAN_KEY,
  MEMBERSHIP_PRO_PLAN_KEY,
] as const;

export type MembershipPlanKey = (typeof MEMBERSHIP_PLAN_KEYS)[number];

const MEMBERSHIP_PLAN_RANKS: Record<MembershipPlanKey, number> = {
  [MEMBERSHIP_PLUS_PLAN_KEY]: 1,
  [MEMBERSHIP_PRO_PLAN_KEY]: 2,
};

/**
 * 判断传入值是否是当前系统支持的会员套餐 key。
 *
 * @param value 待检查的字符串。
 * @returns 如果值是 Plus 或 Pro 套餐 key，则返回 true。
 * @remarks 后续增加新档位时，应先扩展 MEMBERSHIP_PLAN_KEYS 和 rank。
 */
export function isMembershipPlanKey(value: string): value is MembershipPlanKey {
  return (MEMBERSHIP_PLAN_KEYS as readonly string[]).includes(value);
}

/**
 * 将外部输入规范化为已知套餐 key。
 *
 * @param planKey 外部传入的套餐 key，可以为空或未知。
 * @returns 已知套餐 key；未知值按历史默认行为回落到 Plus。
 * @remarks 保留未知值回落 Plus，是为了兼容旧接口默认开通 Plus 的行为。
 */
export function normalizeMembershipPlanKey(
  planKey?: string | null,
): MembershipPlanKey {
  return isMembershipPlanKey(planKey ?? '')
    ? (planKey as MembershipPlanKey)
    : MEMBERSHIP_PLUS_PLAN_KEY;
}

/**
 * 根据套餐 key 解析 membership_config 表中的配置 ID。
 *
 * @param planKey 套餐 key。
 * @returns Pro 使用自身 key，Plus 沿用历史 default 配置行。
 */
export function resolveMembershipConfigId(planKey: string): string {
  return planKey === MEMBERSHIP_PRO_PLAN_KEY
    ? MEMBERSHIP_PRO_PLAN_KEY
    : MEMBERSHIP_PLUS_CONFIG_ID;
}

/**
 * 根据配置 ID 反解套餐 key。
 *
 * @param configId membership_config.id。
 * @returns 已知套餐 key；非 Pro 配置按 Plus 处理。
 */
export function resolveMembershipPlanKey(configId: string): MembershipPlanKey {
  return configId === MEMBERSHIP_PRO_PLAN_KEY
    ? MEMBERSHIP_PRO_PLAN_KEY
    : MEMBERSHIP_PLUS_PLAN_KEY;
}

/**
 * 返回套餐的默认展示名称。
 *
 * @param planKey 套餐 key。
 * @returns FateClaw Plus 或 FateClaw Pro。
 */
export function resolveMembershipPlanName(planKey: string): string {
  return planKey === MEMBERSHIP_PRO_PLAN_KEY ? 'FateClaw Pro' : 'FateClaw Plus';
}

/**
 * 返回套餐档位等级。
 *
 * @param planKey 套餐 key。
 * @returns Plus 为 1，Pro 为 2，未知套餐为 0。
 */
export function resolveMembershipPlanRank(planKey?: string | null): number {
  return isMembershipPlanKey(planKey ?? '')
    ? MEMBERSHIP_PLAN_RANKS[planKey as MembershipPlanKey]
    : 0;
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
  const currentPlanKey = normalizeMembershipPlanKey(
    membership?.membership?.plan_key,
  );
  return Boolean(
    membership?.active && membershipPlanMeets(currentPlanKey, requiredPlanKey),
  );
}

/**
 * 判断当前会员是否拥有现有通用会员权益。
 *
 * @param membership 当前会员概览。
 * @returns Plus 及以上套餐有效时返回 true。
 * @remarks 当前产品权益尚未拆分，AI Chat、微信绑定等都以 Plus 及以上为准。
 */
export function hasBaseMembershipEntitlement(
  membership: {
    active: boolean;
    membership: { plan_key: string | null } | null;
  } | null,
): boolean {
  return membershipOverviewMeetsPlan(membership, MEMBERSHIP_PLUS_PLAN_KEY);
}
