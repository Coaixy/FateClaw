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
  PublicStatusStatsDto,
  UsageStatsDto,
  WalletTransactionDto,
} from '@fateclaw/contracts/billing';
import type { SuccessResponse } from '@fateclaw/contracts/common';

import {
  createDailySignInReward,
  getAccountsByUserId,
  getDailySignInConfig,
  getDailySignInRecordByDate,
  getUserById,
  getVisibleWalletTransactionsByUserId,
  resetUserData,
  resetUserMessages,
  resetUserTasks,
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

  return ok(
    toBillingStatusDto({
      monthly_tokens_used: billing.usedTokens,
      estimated_monthly_total_cents: billing.chargedCents,
      purchased_cents: wallet.purchasedCents,
      bonus_cents: wallet.bonusCents,
      reserved_cents: wallet.reservedCents,
      available_cents: wallet.availableCents,
    }),
  );
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
    reward_cents: config.reward_cents,
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
  if (config.reward_cents <= 0) {
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
    rewardCents: config.reward_cents,
    note: `每日签到奖励（${signInDate}）`,
  });
  if (!created) {
    return fail(409, '今日已签到');
  }

  return ok({
    enabled: config.enabled,
    reward_cents: config.reward_cents,
    sign_in_date: signInDate,
    signed_in_today: true,
    signed_in_at: record.created_at,
    received_cents: record.reward_cents,
    bonus_cents: updated.bonus_cents,
    available_cents: Math.max(
      0,
      updated.purchased_cents + updated.bonus_cents - updated.reserved_cents,
    ),
  });
}

export async function resetBillingScope(
  userId: string,
  scope: 'all' | 'messages' | 'memories' | 'tasks',
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
    case 'tasks':
      await resetUserTasks(user.id);
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
