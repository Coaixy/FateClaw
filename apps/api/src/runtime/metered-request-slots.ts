import { getRedis } from '#infrastructure/redis';
import { MAX_REQUEST_TIMEOUT_MS } from '#shared/timeout-chain';

// ---------------------------------------------------------------------------
// per-user 余额感知 metered 并发门
//
// 洞：入口只挡 inArrears（余额<0）、不冻结、不限并发；余额≈0 的会员可开多 session
// 几乎同时发请求，全部放行各自赊账，负债 = 单请求成本 × min(session 数, 全局上限)。
// 修法：低余额用户（availableCoins < 阈值）同一时刻只允许 1 个 metered 请求在跑——
// 那 1 个跑完进入欠费后，后续请求被入口 inArrears 挡住，故最坏赊账锁到「1 个请求」。
// 健康余额用户不进入此门，沿用全局并发上限，零额外开销。
//
// 计数用 per-user ZSET（member=requestId, score=now），acquire 时 ZREMRANGEBYSCORE
// 自动剪除超时窗口外的陈旧项 → 漏释放最多卡一个窗口；再配 PEXPIRE 兜底键过期。
// 释放点（全局槽的各个 release 处）拿不到 userId，故用 requestId→userId 反查键，
// 释放只凭 requestId 即可定位，未 gate 的请求查不到 → 空操作。
// ---------------------------------------------------------------------------
const PER_USER_METERED_ZKEY_PREFIX = 'agent:user-metered:z:';
const PER_USER_METERED_OWNER_PREFIX = 'agent:user-metered:o:';
// 含「积分不足」关键词，chat-session-service 据此映射为 402（见 isPaymentRequiredError）。
export const LOW_BALANCE_CONCURRENCY_MESSAGE =
  '积分不足以同时进行多个解读，请等当前解读完成或充值后再试';

function perUserMeteredZKey(userId: string): string {
  return `${PER_USER_METERED_ZKEY_PREFIX}${userId}`;
}
function perUserMeteredOwnerKey(requestId: string): string {
  return `${PER_USER_METERED_OWNER_PREFIX}${requestId}`;
}

/**
 * 尝试为低余额用户领取一个 per-user metered 在途名额。
 *
 * @returns 名额未满则占用并返回 true；已达上限返回 false（调用方应拒绝该请求）。
 * @remarks 仅对低余额 metered 请求调用；陈旧项按超时窗口自动剪除，避免漏释放永久锁死。
 */
export async function tryAcquirePerUserMeteredSlot(input: {
  userId: string;
  requestId: string;
  limit: number;
}): Promise<boolean> {
  const now = Date.now();
  // 超时窗口：取两类请求超时的较大值，确保不会把仍可能在途的请求误剪。
  const staleMs = MAX_REQUEST_TIMEOUT_MS;
  const acquired = await getRedis().eval(
    `
    redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[3])
    if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[1]) then
      return 0
    end
    redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
    redis.call('PEXPIRE', KEYS[1], ARGV[5])
    return 1
    `,
    1,
    perUserMeteredZKey(input.userId),
    input.limit,
    now,
    now - staleMs,
    input.requestId,
    staleMs,
  );
  if (acquired === 1) {
    // 反查键：释放点只有 requestId，借此定位 userId。带 TTL 兜底漏释放。
    await getRedis().set(
      perUserMeteredOwnerKey(input.requestId),
      input.userId,
      'PX',
      staleMs,
    );
    return true;
  }
  return false;
}

/**
 * 释放某请求占用的 per-user metered 名额（只凭 requestId）。
 *
 * @remarks 幂等：未 gate 或已释放的请求查不到反查键 → 直接返回，无副作用；
 *          可在所有全局槽释放点无条件调用，对非 gated（含微信）请求是空操作。
 *          导出供 inbox-stall-sweeper 在代消费无主 outbox 响应时释放对应名额。
 */
export async function releasePerUserMeteredSlotByRequestId(
  requestId?: string,
): Promise<void> {
  if (!requestId) return;
  const ownerKey = perUserMeteredOwnerKey(requestId);
  const userId = await getRedis().get(ownerKey);
  if (!userId) return;
  await getRedis().zrem(perUserMeteredZKey(userId), requestId);
  await getRedis().del(ownerKey);
}
