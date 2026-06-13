/**
 * 计费 HTTP 场景服务层。
 *
 * 将计费快照和数据重置流程从 route 中抽离，
 * 让接口层只负责鉴权和返回状态码。
 */

import type {
  BillingStatusDto,
  DailyUsageRowDto,
  DailySignInResultDto,
  DailySignInStatusDto,
  MembershipSubscribeResultDto,
  PublicStatusStatsDto,
  UsageStatsDto,
  WalletTransactionDto,
} from '@fateclaw/contracts/billing';
import type { SuccessResponse } from '@fateclaw/contracts/common';

import {
  createDailySignInReward,
  subscribeMembershipWithWallet,
  getAccountsByUserId,
  getDailySignInConfig,
  getDailySignInRecordByDate,
  getUserById,
  getVisibleWalletTransactionsByUserId,
  resetUserData,
  resetUserMessages,
  updateSoulContent,
  updateUserSoulContent,
} from '../../infrastructure/db.js';
import {
  getDailyUsageRows,
  getPublicStatusStats,
  getUsageStats,
} from '../../infrastructure/daily-usage.js';
import {
  getMonthlyMeteredBillingSummary,
  getMembershipBillingSummary,
  getMembershipPlanSummaries,
  getWalletBalanceSummary,
} from './plans.js';
import { fail, ok, type ServiceResult } from '../../shared/service-result.js';
import {
  toBillingStatusDto,
  toDailyUsageRowsDto,
  toWalletTransactionsDto,
  toUsageStatsDto,
} from '../../contracts-adapter/billing-contract.js';

function todaySignInDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function getBillingOverview(
  userId: string,
): Promise<ServiceResult<BillingStatusDto>> {
  const user = await getUserById(userId);
  if (!user) {
    return fail(404, '用户不存在');
  }

  const billing = await getMonthlyMeteredBillingSummary(user.id);
  const wallet = await getWalletBalanceSummary(user.id);
  const membership = await getMembershipBillingSummary(user.id);
  const membershipPlans = await getMembershipPlanSummaries();

  return ok(
    toBillingStatusDto({
      monthly_tokens_used: billing.usedTokens,
      estimated_monthly_total_coins: billing.chargedCoins,
      purchased_coins: wallet.purchasedCoins,
      bonus_coins: wallet.bonusCoins,
      reserved_coins: wallet.reservedCoins,
      available_coins: wallet.availableCoins,
      membership: {
        enabled: membership.enabled,
        active: membership.active,
        plan_key: membership.planKey,
        monthly_price_coins: membership.monthlyPriceCoins,
        display_price_coins: membership.displayPriceCoins,
        current_period_start: membership.currentPeriodStart,
        current_period_end: membership.currentPeriodEnd,
        allowance_reset_at: membership.allowanceResetAt,
        allowance_used_ratio: membership.allowanceUsedRatio,
        allowance_status: membership.allowanceStatus,
      },
      membership_plans: membershipPlans.map((plan) => ({
        plan_key: plan.planKey,
        name: plan.name,
        enabled: plan.enabled,
        monthly_price_coins: plan.monthlyPriceCoins,
        display_price_coins: plan.displayPriceCoins,
        monthly_allowance_units: plan.monthlyAllowanceUnits,
        standard_price_per_million_units_coins:
          plan.standardPricePerMillionUnitsCoins,
        updated_at: plan.updatedAt,
      })),
    }),
  );
}

export async function subscribeCurrentUserMembership(
  userId: string,
  planKey?: string,
): Promise<ServiceResult<MembershipSubscribeResultDto>> {
  const user = await getUserById(userId);
  if (!user) {
    return fail(404, '用户不存在');
  }
  try {
    const result = await subscribeMembershipWithWallet(user.id, planKey);
    const wallet = await getWalletBalanceSummary(result.user.id);
    const membership = await getMembershipBillingSummary(result.user.id);
    return ok({
      membership: {
        enabled: membership.enabled,
        active: membership.active,
        plan_key: membership.planKey,
        monthly_price_coins: membership.monthlyPriceCoins,
        display_price_coins: membership.displayPriceCoins,
        current_period_start: membership.currentPeriodStart,
        current_period_end: membership.currentPeriodEnd,
        allowance_reset_at: membership.allowanceResetAt,
        allowance_used_ratio: membership.allowanceUsedRatio,
        allowance_status: membership.allowanceStatus,
      },
      purchased_coins: wallet.purchasedCoins,
      bonus_coins: wallet.bonusCoins,
      available_coins: wallet.availableCoins,
    });
  } catch (err) {
    return fail(400, err instanceof Error ? err.message : '开通会员失败');
  }
}

export async function getBillingUsage(
  userId: string,
): Promise<ServiceResult<UsageStatsDto>> {
  const user = await getUserById(userId);
  if (!user) {
    return fail(404, '用户不存在');
  }
  return ok(toUsageStatsDto(await getUsageStats(user.id)));
}

export async function getBillingDailyUsage(
  userId: string,
): Promise<ServiceResult<DailyUsageRowDto[]>> {
  const user = await getUserById(userId);
  if (!user) {
    return fail(404, '用户不存在');
  }
  return ok(toDailyUsageRowsDto(await getDailyUsageRows(user.id)));
}

export async function getPublicStatusOverview(): Promise<
  ServiceResult<PublicStatusStatsDto>
> {
  return ok(await getPublicStatusStats());
}

export async function getBillingTransactions(
  userId: string,
  limit: number,
): Promise<ServiceResult<WalletTransactionDto[]>> {
  const user = await getUserById(userId);
  if (!user) {
    return fail(404, '用户不存在');
  }
  return ok(
    toWalletTransactionsDto(
      await getVisibleWalletTransactionsByUserId(user.id, limit),
    ),
  );
}

/**
 * 获取当前用户每日签到状态。
 *
 * 返回后台开关、奖励金额、当天日期和用户是否已签到；日期按现有用量统计的 UTC 日期口径计算。
 */
export async function getDailySignInStatus(
  userId: string,
): Promise<ServiceResult<DailySignInStatusDto>> {
  const user = await getUserById(userId);
  if (!user) {
    return fail(404, '用户不存在');
  }

  const signInDate = todaySignInDate();
  const [config, record] = await Promise.all([
    getDailySignInConfig(),
    getDailySignInRecordByDate(user.id, signInDate),
  ]);

  return ok({
    enabled: config.enabled,
    reward_coins: config.reward_coins,
    sign_in_date: signInDate,
    signed_in_today: Boolean(record),
    signed_in_at: record?.created_at ?? null,
  });
}

/**
 * 领取每日签到软妹币奖励。
 *
 * 奖励以赠送余额入账；同一用户同一日期只允许成功领取一次。
 */
export async function claimDailySignInReward(
  userId: string,
): Promise<ServiceResult<DailySignInResultDto>> {
  const user = await getUserById(userId);
  if (!user) {
    return fail(404, '用户不存在');
  }

  const config = await getDailySignInConfig();
  if (!config.enabled) {
    return fail(403, '每日签到暂未开启');
  }
  if (config.reward_coins <= 0) {
    return fail(400, '每日签到奖励未配置');
  }

  const signInDate = todaySignInDate();
  const existing = await getDailySignInRecordByDate(user.id, signInDate);
  if (existing) {
    return fail(409, '今日已签到');
  }

  const { user: updated, record, created } = await createDailySignInReward({
    userId: user.id,
    signInDate,
    rewardCoins: config.reward_coins,
    note: `每日签到奖励（${signInDate}）`,
  });
  if (!created) {
    return fail(409, '今日已签到');
  }

  return ok({
    enabled: config.enabled,
    reward_coins: config.reward_coins,
    sign_in_date: signInDate,
    signed_in_today: true,
    signed_in_at: record.created_at,
    received_coins: record.reward_coins,
    bonus_coins: updated.bonus_coins,
    available_coins: updated.purchased_coins + updated.bonus_coins,
  });
}

export async function resetBillingScope(
  userId: string,
  scope: 'all' | 'messages' | 'memories',
): Promise<ServiceResult<SuccessResponse>> {
  const user = await getUserById(userId);
  if (!user) {
    return fail(404, '用户不存在');
  }

  const clearSoul = async () => {
    await updateUserSoulContent(user.id, '');
    const accountIds = (await getAccountsByUserId(user.id)).map((a) => a.id);
    for (const accountId of accountIds) {
      await updateSoulContent(accountId, '');
    }
  };

  switch (scope) {
    case 'messages':
      await resetUserMessages(user.id);
      break;
    case 'memories':
      await clearSoul();
      break;
    case 'all':
    default: {
      const accountIds = await resetUserData(user.id);
      await updateUserSoulContent(user.id, '');
      for (const accountId of accountIds) {
        await updateSoulContent(accountId, '');
      }
      break;
    }
  }

  return ok({ success: true });
}
