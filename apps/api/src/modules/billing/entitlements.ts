import {
  expireUserBonusBalanceBefore,
  getMembershipOverview,
  getUserById,
} from '#infrastructure/db';
import {
  calculateAvailableSpendableCoins,
  isSpendableBalanceInArrears,
} from '#shared/balance-coins';

/** Central switch for the currently disabled WeChat integration. */
const WECHAT_CLAW_FEATURE_ENABLED = false;

/** Request-level capabilities consumed directly by runtime and business services. */
export interface RuntimeEntitlementSnapshot {
  userId: string;
  membershipActive: boolean;
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

/** Reads the membership and wallet state used for request admission and billing. */
export async function getRuntimeEntitlementSnapshot(
  userId: string,
): Promise<RuntimeEntitlementSnapshot> {
  await expireUserBonusBalanceBefore(userId, new Date().toISOString());
  const [membership, user] = await Promise.all([
    getMembershipOverview(userId),
    getUserById(userId),
  ]);
  const walletState = {
    purchased_coins: user?.purchased_coins ?? 0,
    bonus_coins: user?.bonus_coins ?? 0,
    reserved_coins: user?.reserved_coins ?? 0,
  };

  return {
    userId,
    membershipActive: membership.active,
    // Active membership provides access to the priority queue.
    hasPriorityQueue: membership.active,
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
