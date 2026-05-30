/**
 * 计费 HTTP 场景服务层。
 *
 * 将计费快照和数据重置流程从 route 中抽离，
 * 让接口层只负责鉴权和返回状态码。
 */

import type {
  BillingStatusDto,
  DailyUsageRowDto,
  PublicStatusStatsDto,
  UsageStatsDto,
  WalletTransactionDto,
} from '@fateclaw/contracts/billing';
import type { SuccessResponse } from '@fateclaw/contracts/common';

import {
  getAccountsByUserId,
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
