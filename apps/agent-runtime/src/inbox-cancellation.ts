import { log } from './io.js';
import { decodeAgentIpc } from './ipc-security.js';
import type { CancelInboxRequest } from './types.js';

export type SessionControls = { abort: () => Promise<void> };

type CancelQueueRedis = {
  rpop: (key: string) => Promise<string | null>;
};

const PENDING_CANCEL_TTL_MS = 35 * 60 * 1000;

export function cleanupExpiredPendingCancelRequests(
  pendingCancelRequests: Map<string, number>,
  now = Date.now(),
): void {
  for (const [requestId, createdAt] of pendingCancelRequests) {
    if (now - createdAt > PENDING_CANCEL_TTL_MS) {
      pendingCancelRequests.delete(requestId);
    }
  }
}

function parseCancelInboxRequest(raw: string): CancelInboxRequest | null {
  const parsed = JSON.parse(raw) as Partial<CancelInboxRequest>;
  if (parsed.type !== 'cancel' || !parsed.requestId || !parsed.accountId) {
    return null;
  }

  return parsed as CancelInboxRequest;
}

export async function drainCancelRequests(
  accountId: string,
  activeSessions: Map<string, SessionControls>,
  pendingCancelRequests: Map<string, number>,
  redis: CancelQueueRedis,
): Promise<void> {
  cleanupExpiredPendingCancelRequests(pendingCancelRequests);
  const queue = `ipc:${accountId}:cancel`;
  while (true) {
    const raw = await redis.rpop(queue);
    if (typeof raw !== 'string') {
      return;
    }

    try {
      const cancelRequest = parseCancelInboxRequest(decodeAgentIpc(queue, raw));
      if (!cancelRequest) {
        log('忽略无效的 cancel 请求');
        continue;
      }
      if (cancelRequest.accountId !== accountId) {
        log(
          `忽略账号不匹配的 cancel 请求 expected=${accountId} actual=${cancelRequest.accountId}`,
        );
        continue;
      }

      const activeSession = activeSessions.get(cancelRequest.requestId);
      if (activeSession) {
        await activeSession.abort();
        log(
          `已中断收件箱请求 requestId=${cancelRequest.requestId} reason=${cancelRequest.reason ?? 'user_stop'}`,
        );
      } else {
        pendingCancelRequests.set(cancelRequest.requestId, Date.now());
        log(
          `收到中断请求，等待活动会话就绪 requestId=${cancelRequest.requestId}`,
        );
      }
    } catch (error) {
      log(
        `处理 cancel 请求失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
