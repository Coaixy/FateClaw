import { randomUUID } from 'node:crypto';
import {
  PAIPAN_RPC_TIMEOUT_MS,
  paipanRequestQueue,
  paipanResponseQueue,
  type PaipanCaller,
  type PaipanIpcRequest,
  type PaipanResult,
} from '@fateclaw/contracts/agent/paipan';

import { getRedis } from '#agent/redis';
import { decodeAgentIpc, encodeAgentIpc } from '#agent/ipc-security';

export function createPaipanCaller(identity: {
  accountId: string;
  requestId: string;
  executionId: string;
}): PaipanCaller {
  return async (operation, signal) => {
    if (signal?.aborted)
      return { ok: false, code: 'PAIPAN.CANCELLED', error: '起盘已取消' };
    const redis = getRedis();
    // A blocking reply read must not delay heartbeats or other turns on the command connection.
    const consumer = redis.duplicate({
      commandTimeout: undefined,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
    });
    // Awaited commands report failures; connection events must not print command arguments.
    consumer.on('error', () => {});
    const rpcId = randomUUID();
    const queue = paipanRequestQueue(identity.accountId);
    const replyQueue = paipanResponseQueue(identity.accountId, rpcId);
    const request: PaipanIpcRequest = {
      rpcId,
      requestId: identity.requestId,
      executionId: identity.executionId,
      operation,
    };
    let timedOut = false;
    const close = () => consumer.disconnect();
    const timer = setTimeout(() => {
      timedOut = true;
      close();
    }, PAIPAN_RPC_TIMEOUT_MS);
    timer.unref();
    signal?.addEventListener('abort', close, { once: true });
    try {
      await consumer.connect();
      if (signal?.aborted) throw new Error('Cancelled');
      const sent = await redis
        .multi()
        .lpush(
          queue,
          encodeAgentIpc(queue, JSON.stringify(request), PAIPAN_RPC_TIMEOUT_MS),
        )
        .expire(queue, 30)
        .exec();
      if (!sent || sent.some(([error]) => error))
        throw new Error('Paipan request was not committed');
      const reply = await consumer.brpop(
        replyQueue,
        PAIPAN_RPC_TIMEOUT_MS / 1000,
      );
      if (!reply) {
        timedOut = true;
        throw new Error('Timed out');
      }
      const response = JSON.parse(decodeAgentIpc(replyQueue, reply[1])) as {
        rpcId: string;
        result: PaipanResult;
      };
      if (
        response.rpcId !== rpcId ||
        !response.result ||
        typeof response.result.ok !== 'boolean'
      )
        throw new Error('Invalid paipan reply');
      return response.result;
    } catch {
      return {
        ok: false,
        code: signal?.aborted
          ? 'PAIPAN.CANCELLED'
          : timedOut
            ? 'PAIPAN.TIMEOUT'
            : 'PAIPAN.UNAVAILABLE',
        error: signal?.aborted
          ? '起盘已取消；已保存的盘面仍会保留在会话中'
          : '起盘服务未能返回结果，请检查会话中是否已生成盘面；不要自动重复起卦',
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', close);
      close();
    }
  };
}
