import {
  expireUserBonusBalanceBefore,
  getMembershipOverview,
  getUserById,
} from '../../infrastructure/db.js';
import {
  calculateAvailableSpendableCoins,
  isSpendableBalanceInArrears,
} from '../../shared/balance-coins.js';
import {
  hasCustomModelEntitlement,
  hasPaidMembershipEntitlement,
  hasPriorityQueueEntitlement,
  hasWechatClawEntitlement,
  normalizeMembershipPlanKey,
  resolveMembershipPlanRank,
  resolveProfessionalAiDailyTurnLimit,
  type MembershipPlanKey,
} from '../../shared/membership-plans.js';

/**
 * runtime 和业务服务消费的统一会员权益快照。
 *
 * 字段按“可消费能力”组织，调用方应直接读取布尔能力与每日次数上限，
 * 不要在各模块内重新根据 planKey 推导微信 Claw、优先队列或自配模型权限。
 */
export interface RuntimeEntitlementSnapshot {
  userId: string;
  membershipActive: boolean;
  planKey: MembershipPlanKey | null;
  planRank: number;
  hasPaidMembership: boolean;
  hasPriorityQueue: boolean;
  canUseCustomModel: boolean;
  canUseWechatClaw: boolean;
  professionalAiDailyTurnLimit: number;
  wallet: {
    purchasedCoins: number;
    bonusCoins: number;
    reservedCoins: number;
    availableCoins: number;
    inArrears: boolean;
  };
}

/**
 * 读取用户在当前请求中的统一权益快照。
 *
 * @param userId 平台用户 ID。
 * @returns 会员状态、套餐能力、专家次数上限和钱包余额的同一时点快照。
 * @remarks 调用方只能消费布尔能力，不应重新解释 planKey。
 */
export async function getRuntimeEntitlementSnapshot(
  userId: string,
): Promise<RuntimeEntitlementSnapshot> {
  await expireUserBonusBalanceBefore(userId, new Date().toISOString());
  const [membership, user] = await Promise.all([
    getMembershipOverview(userId),
    getUserById(userId),
  ]);
  const activePlanKey =
    membership.active && membership.membership?.plan_key
      ? normalizeMembershipPlanKey(membership.membership.plan_key)
      : null;
  const walletState = {
    purchased_coins: user?.purchased_coins ?? 0,
    bonus_coins: user?.bonus_coins ?? 0,
    reserved_coins: user?.reserved_coins ?? 0,
  };

  return {
    userId,
    membershipActive: membership.active,
    planKey: activePlanKey,
    planRank: resolveMembershipPlanRank(activePlanKey),
    hasPaidMembership: hasPaidMembershipEntitlement(membership),
    hasPriorityQueue: hasPriorityQueueEntitlement(membership),
    canUseCustomModel: hasCustomModelEntitlement(membership),
    canUseWechatClaw: hasWechatClawEntitlement(membership),
    professionalAiDailyTurnLimit:
      resolveProfessionalAiDailyTurnLimit(activePlanKey),
    wallet: {
      purchasedCoins: walletState.purchased_coins,
      bonusCoins: walletState.bonus_coins,
      reservedCoins: walletState.reserved_coins,
      availableCoins: calculateAvailableSpendableCoins(walletState),
      inArrears: isSpendableBalanceInArrears(walletState),
    },
  };
}
