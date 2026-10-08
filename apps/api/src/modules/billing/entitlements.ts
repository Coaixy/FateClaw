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
  normalizeMembershipPlanKey,
  resolveMembershipPlanRank,
  type MembershipPlanKey,
} from '../../shared/membership-plans.js';

/**
 * 微信 Claw 功能总开关（可逆停用的集中控制点）。
 *
 * 产品决策：微信 Claw 暂不对外提供（迁移 0057 已把 accounts.enabled=false 作数据层双保险）。
 * 单层化后不再有 Deep 档位，故此处用一个集中常量替代原"按 Deep 档推导"的耦合逻辑：
 * 未来恢复微信功能时，只需把此常量改回 true（届时按 membership.active 对所有有效卦师开放），
 * 无需改动任何档位/权益判断。代码侧微信链路（ilink/poller/QR 路由）全部保留待恢复。
 */
const WECHAT_CLAW_FEATURE_ENABLED = false;

/**
 * runtime 和业务服务消费的统一会员权益快照。
 *
 * 字段按“可消费能力”组织，调用方应直接读取布尔能力，
 * 不要在各模块内重新根据 planKey 推导微信 Claw 或优先队列权限。
 */
export interface RuntimeEntitlementSnapshot {
  userId: string;
  membershipActive: boolean;
  planKey: MembershipPlanKey | null;
  planRank: number;
  hasPaidMembership: boolean;
  hasPriorityQueue: boolean;
  canUseWechatClaw: boolean;
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
 * @returns 会员状态、套餐能力和钱包余额的同一时点快照。
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
    // Active membership provides access to the priority queue.
    hasPriorityQueue: membership.active,
    // 微信 Claw 由集中总开关 WECHAT_CLAW_FEATURE_ENABLED 控制（当前 false → 恒不可用）。
    // 功能已在迁移 0057 数据层可逆停用（accounts.enabled=false → 启动不拉起 iLink 轮询、
    // 前端无绑定入口、状态页不展示微信卡）。恢复时把常量改回 true 即对所有有效卦师开放。
    canUseWechatClaw: WECHAT_CLAW_FEATURE_ENABLED && membership.active,
    wallet: {
      purchasedCoins: walletState.purchased_coins,
      bonusCoins: walletState.bonus_coins,
      reservedCoins: walletState.reserved_coins,
      availableCoins: calculateAvailableSpendableCoins(walletState),
      inArrears: isSpendableBalanceInArrears(walletState),
    },
  };
}
