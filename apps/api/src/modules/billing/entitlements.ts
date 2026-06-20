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
  hasPaidMembershipEntitlement,
  hasWechatClawEntitlement,
  normalizeMembershipPlanKey,
  resolveMembershipPlanRank,
  type MembershipPlanKey,
} from '../../shared/membership-plans.js';

/** 单层卦师使用权的每日专家解读轮次上限（防滥用，可调）。 */
const GUASHI_DAILY_TURN_LIMIT = 200;

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
    // 塌缩为单层"卦师使用权"：自定义模型（BYOK）与优先队列不再按档位区分，有效使用权即开放。
    hasPriorityQueue: membership.active,
    canUseCustomModel: membership.active,
    // 微信 Claw 权益判断保留原档位逻辑（仅存量 deep 会员），不在 entitlements 层硬关——
    // 因为该字段被单元测试当作"按档位推导"的纯逻辑。微信【功能】已在数据层可逆停用：
    // 迁移 0057 将所有 accounts.enabled 置 false → 启动不再拉起 iLink 轮询，前端亦无绑定入口，
    // 状态页不再展示微信卡。未来恢复只需重新启用账号（无 enabled 账号即无微信链路）。
    canUseWechatClaw: hasWechatClawEntitlement(membership),
    professionalAiDailyTurnLimit: membership.active
      ? GUASHI_DAILY_TURN_LIMIT
      : 0,
    wallet: {
      purchasedCoins: walletState.purchased_coins,
      bonusCoins: walletState.bonus_coins,
      reservedCoins: walletState.reserved_coins,
      availableCoins: calculateAvailableSpendableCoins(walletState),
      inArrears: isSpendableBalanceInArrears(walletState),
    },
  };
}
