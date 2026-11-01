import {
  MEMORY_RPC_TIMEOUT_MS,
  isMemoryIpcRequest,
  memoryResponseQueue,
  type MemoryResult,
} from '@fateclaw/contracts/agent/memory';

import { getRedis } from '#infrastructure/redis';
import { logger } from '#infrastructure/logger';
import { MemoryError } from '#modules/memory/domain';
import { executeMemoryOperation } from '#modules/memory/service';
import { encodeRuntimeIpc } from './ipc-security.js';

export async function processMemoryToolPayload(
  payload: unknown,
  accountId: string,
): Promise<void> {
  if (!isMemoryIpcRequest(payload))
    throw new Error('Invalid memory tool request');
  let result: MemoryResult;
  try {
    result = await executeMemoryOperation(accountId, payload);
  } catch (error) {
    if (error instanceof MemoryError)
      result = { ok: false, code: error.code, error: error.message };
    else {
      logger.error(
        {
          accountId,
          requestId: payload.requestId,
          errorType: error instanceof Error ? error.name : 'unknown',
        },
        'Memory tool execution failed',
      );
      result = {
        ok: false,
        code: 'MEMORY.UNAVAILABLE',
        error: '记忆服务暂时不可用；不要声称已读取或保存记忆',
      };
    }
  }
  // Hydrated text belongs only in the authenticated reply, never in chat events or logs.
  const queue = memoryResponseQueue(accountId, payload.rpcId);
  const envelope = encodeRuntimeIpc(
    accountId,
    queue,
    JSON.stringify({ rpcId: payload.rpcId, result }),
    MEMORY_RPC_TIMEOUT_MS,
  );
  const replies = await getRedis()
    .multi()
    .lpush(queue, envelope)
    .expire(queue, Math.ceil(MEMORY_RPC_TIMEOUT_MS / 1000))
    .exec();
  const failure = replies?.find(([error]) => error)?.[0];
  if (!replies || failure) throw new Error('Memory reply was not committed');
}
