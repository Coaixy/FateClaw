/**
 * 计费 HTTP 场景服务层。
 *
 * 将计费快照和数据重置流程从 route 中抽离，
 * 让接口层只负责鉴权和返回状态码。
 */

import type {
  BillingStatusDto,
  DailyUsageRowDto,
  MembershipSubscribeResultDto,
  PublicStatusOverviewDto,
  PublicStatusServiceKeyDto,
  UsageStatsDto,
  WalletTransactionDto,
} from '@fateclaw/contracts/billing';
import type { SuccessResponse } from '@fateclaw/contracts/common';

import {
  subscribeMembershipWithWallet,
  getAccountsByUserId,
  getMembershipEntitlements,
  getUserById,
  getVisibleWalletTransactionsByUserId,
  resetUserData,
  resetUserMessages,
  updateSoulContent,
  updateUserSoulContent,
} from '../../infrastructure/db.js';
import {
  getDailyUsageRows,
  getUsageStats,
} from '../../infrastructure/daily-usage.js';
import {
  getMonthlyMeteredBillingSummary,
  getMembershipBillingSummary,
  getMembershipPlanSummaries,
  getWalletBalanceSummary,
} from './plans.js';
import { fail, ok, type ServiceResult } from '../../shared/service-result.js';
import { getRedis } from '../../infrastructure/redis.js';
import {
  toBillingStatusDto,
  toDailyUsageRowsDto,
  toMembershipSubscribeResultDto,
  toWalletTransactionsDto,
  toUsageStatsDto,
} from '../../contracts-adapter/billing-contract.js';

// 微信 Claw 已可逆停用：状态页不再展示"微信绑定"服务卡。
// PublicStatusServiceKeyDto 联合仍保留 'wechat_binding'（待恢复），此处仅运行时不输出。
const PUBLIC_STATUS_SERVICE_KEYS: PublicStatusServiceKeyDto[] = [
  'ai_chat',
  'wallet',
  'membership',
];

export async function getBillingOverview(
  userId: string,
): Promise<ServiceResult<BillingStatusDto>> {
  const user = await getUserById(userId);
  if (!user) {
    return fail(404, '用户不存在');
  }

  const billing = await getMonthlyMeteredBillingSummary(user.id);
  const wallet = await getWalletBalanceSummary(user.id);
  const [membership, membershipEntitlements, membershipPlans] =
    await Promise.all([
      getMembershipBillingSummary(user.id),
      getMembershipEntitlements(user.id),
      getMembershipPlanSummaries(),
    ]);

  return ok(
    toBillingStatusDto({
      billing,
      wallet,
      membership,
      membershipEntitlements,
      membershipPlans,
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
  // 幂等防抖(membership-3):订阅接口无幂等键,误触双击/客户端重试会连续多扣多个月会费
  // (每次都真实扣费+真实加期,用户亏)。用 SETNX + 短 TTL 作轻量去重锁:同一用户 10s 内
  // 只放行第一笔订阅请求,后续重复提交直接拒绝。
  const lockKey = `billing:subscribe:lock:${user.id}`;
  const acquired = await getRedis().set(lockKey, '1', 'EX', 10, 'NX');
  if (acquired !== 'OK') {
    return fail(429, '操作过于频繁，请勿重复提交');
  }
  try {
    const result = await subscribeMembershipWithWallet(user.id, planKey);
    const wallet = await getWalletBalanceSummary(result.user.id);
    const membership = await getMembershipBillingSummary(result.user.id);
    return ok(toMembershipSubscribeResultDto({ membership, wallet }));
  } catch (err) {
    // 失败未扣费,释放去重锁以便用户立即重试(成功则保留锁满足防抖窗口)。
    await getRedis()
      .del(lockKey)
      .catch(() => {});
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

/**
 * 读取公开系统状态页的轻量服务可用性信息。
 *
 * @returns 不含用户规模、队列和 Token 消耗的公开状态概览。
 */
export async function getPublicStatusOverview(): Promise<
  ServiceResult<PublicStatusOverviewDto>
> {
  return ok({
    updated_at: new Date().toISOString(),
    overall_status: 'operational',
    services: PUBLIC_STATUS_SERVICE_KEYS.map((key) => ({
      key,
      status: 'operational',
    })),
  });
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
