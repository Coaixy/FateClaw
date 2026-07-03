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
  MembershipSubscribeDebounceError,
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

/** 订阅去抖窗口：同一用户同档位在此窗口内的重复提交会被拒，防连点/重试重复扣费。 */
const SUBSCRIBE_DEBOUNCE_MS = 10_000;

export async function subscribeCurrentUserMembership(
  userId: string,
  planKey?: string,
): Promise<ServiceResult<MembershipSubscribeResultDto>> {
  const user = await getUserById(userId);
  if (!user) {
    return fail(404, '用户不存在');
  }

  // 幂等去抖：订阅每次调用都实扣月费（subscribeMembershipWithWallet 无幂等键），
  // 连点/网络重试会重复扣费并叠加月数。用 Redis SET NX 短锁做去抖：
  // - 成功开通后锁保留到 TTL 自然过期，挡住窗口内的重复点击；
  // - 开通失败（未扣费）主动释放锁，允许用户（如充值后）立即重试；
  // - Redis 异常时 fail-open，绝不因去抖阻断正常开通。
  const lockKey = `membership:subscribe:lock:${user.id}:${planKey ?? 'default'}`;
  let lockAcquired = false;
  try {
    lockAcquired =
      (await getRedis().set(
        lockKey,
        '1',
        'PX',
        SUBSCRIBE_DEBOUNCE_MS,
        'NX',
      )) !== null;
  } catch {
    lockAcquired = true;
  }
  if (!lockAcquired) {
    return fail(409, '订阅处理中，请勿重复提交');
  }

  try {
    const result = await subscribeMembershipWithWallet(user.id, planKey);
    const wallet = await getWalletBalanceSummary(result.user.id);
    const membership = await getMembershipBillingSummary(result.user.id);
    return ok(toMembershipSubscribeResultDto({ membership, wallet }));
  } catch (err) {
    if (err instanceof MembershipSubscribeDebounceError) {
      // DB 层去抖命中（Redis 去抖失效时的兜底）：正常的重复拦截而非开通失败，
      // 保留 Redis 去抖锁，按与 Redis 去抖一致的语义返回 409。
      return fail(409, err.message);
    }
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
