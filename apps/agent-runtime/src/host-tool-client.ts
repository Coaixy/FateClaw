import { randomUUID } from 'node:crypto';
import {
  PAIPAN_RPC_TIMEOUT_MS,
  paipanRequestQueue,
  paipanResponseQueue,
  type PaipanCaller,
  type PaipanOperation,
  type PaipanResult,
} from '@fateclaw/contracts/agent/paipan';
import {
  VISUALIZATION_RPC_TIMEOUT_MS,
  visualizationRequestQueue,
  visualizationResponseQueue,
  type VisualizationCaller,
  type VisualizationOperation,
  type VisualizationResult,
} from '@fateclaw/contracts/agent/visualization';
import { parseVisualizationArtifact } from '@fateclaw/contracts/visualization';
import {
  MEMORY_RPC_TIMEOUT_MS,
  memoryRequestQueue,
  memoryResponseQueue,
  type MemoryCaller,
  type MemoryOperation,
  type MemoryResult,
} from '@fateclaw/contracts/agent/memory';
import { parseMemoryResult } from './memory-client.js';

import { getRedis } from '#agent/redis';
import { decodeAgentIpc, encodeAgentIpc } from '#agent/ipc-security';

export interface HostToolIdentity {
  accountId: string;
  requestId: string;
  executionId: string;
}

export function createHostToolCaller(
  kind: 'paipan',
  identity: HostToolIdentity,
): PaipanCaller;
export function createHostToolCaller(
  kind: 'visualization',
  identity: HostToolIdentity,
): VisualizationCaller;
export function createHostToolCaller(
  kind: 'memory',
  identity: HostToolIdentity,
): MemoryCaller;
export function createHostToolCaller(
  kind: 'paipan' | 'visualization' | 'memory',
  identity: HostToolIdentity,
): PaipanCaller | VisualizationCaller | MemoryCaller {
  const call = async (
    operation: PaipanOperation | VisualizationOperation | MemoryOperation,
    signal?: AbortSignal,
  ): Promise<PaipanResult | VisualizationResult | MemoryResult> => {
    const prefix =
      kind === 'paipan'
        ? 'PAIPAN'
        : kind === 'memory'
          ? 'MEMORY'
          : 'VISUALIZATION';
    const noun =
      kind === 'paipan' ? '起盘' : kind === 'memory' ? '记忆操作' : '图形生成';
    if (signal?.aborted)
      return { ok: false, code: `${prefix}.CANCELLED`, error: `${noun}已取消` };
    const redis = getRedis();
    // Blocking replies use a dedicated connection so tools cannot delay heartbeats.
    const consumer = redis.duplicate({
      commandTimeout: undefined,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
    });
    consumer.on('error', () => {});
    const rpcId = randomUUID();
    const queue =
      kind === 'paipan'
        ? paipanRequestQueue(identity.accountId)
        : kind === 'memory'
          ? memoryRequestQueue(identity.accountId)
          : visualizationRequestQueue(identity.accountId);
    const replyQueue =
      kind === 'paipan'
        ? paipanResponseQueue(identity.accountId, rpcId)
        : kind === 'memory'
          ? memoryResponseQueue(identity.accountId, rpcId)
          : visualizationResponseQueue(identity.accountId, rpcId);
    const timeout =
      kind === 'paipan'
        ? PAIPAN_RPC_TIMEOUT_MS
        : kind === 'memory'
          ? MEMORY_RPC_TIMEOUT_MS
          : VISUALIZATION_RPC_TIMEOUT_MS;
    const request = {
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
    }, timeout);
    timer.unref();
    signal?.addEventListener('abort', close, { once: true });
    try {
      await consumer.connect();
      if (signal?.aborted) throw new Error('Cancelled');
      const sent = await redis
        .multi()
        .lpush(queue, encodeAgentIpc(queue, JSON.stringify(request), timeout))
        .expire(queue, 30)
        .exec();
      if (!sent || sent.some(([error]) => error))
        throw new Error('Tool request was not committed');
      const reply = await consumer.brpop(replyQueue, timeout / 1000);
      if (!reply) {
        timedOut = true;
        throw new Error('Timed out');
      }
      const response = JSON.parse(decodeAgentIpc(replyQueue, reply[1])) as {
        rpcId: string;
        result: PaipanResult | VisualizationResult | MemoryResult;
      };
      if (
        response.rpcId !== rpcId ||
        !response.result ||
        typeof response.result.ok !== 'boolean'
      )
        throw new Error('Invalid tool reply');
      if (
        kind === 'visualization' &&
        response.result.ok &&
        (!('artifact' in response.result) ||
          !parseVisualizationArtifact(response.result.artifact))
      )
        throw new Error('Invalid visualization reply');
      return kind === 'memory'
        ? parseMemoryResult(
            response.result,
            (operation as MemoryOperation).mode,
          )
        : response.result;
    } catch {
      return {
        ok: false,
        code: signal?.aborted
          ? `${prefix}.CANCELLED`
          : timedOut
            ? `${prefix}.TIMEOUT`
            : `${prefix}.UNAVAILABLE`,
        error: signal?.aborted
          ? `${noun}已取消；已保存的结果仍会保留在会话中`
          : kind === 'memory'
            ? '记忆服务未能返回结果；不要声称已读取或保存记忆'
            : kind === 'paipan'
              ? '起盘服务未能返回结果，请检查会话中是否已生成盘面；不要自动重复起卦'
              : '图形服务未能返回结果；已保存的图形仍会保留，请用文字继续回答',
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', close);
      close();
    }
  };
  return call as PaipanCaller | VisualizationCaller | MemoryCaller;
}
