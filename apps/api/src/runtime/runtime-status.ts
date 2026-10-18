/**
 * 运行时状态聚合：为 admin 后台的「运行时状态」面板提供一次性快照。
 *
 * 背景：账号级 agent-runtime 掉线、队列堆积、监听器泄漏此前只能靠翻日志或等
 * 巡检告警被动发现。本模块把分散在各处的运行态（本地子进程、IPC 监听器、
 * pending 请求、Redis 队列深度、runtime 心跳、全局并发闸门）聚合成一个只读
 * 快照，让"系统现在健不健康"可以被主动看见。
 *
 * 注意：本进程内存态（子进程/监听器/pending）只反映当前 API 实例；
 * Redis 侧数据（队列/心跳/并发闸门）是全局的。
 */

import { getRedis } from '../infrastructure/redis.js';
import { getAgentPerformance } from './agent-performance.js';
import {
  getLocalAgentRuntimeStatus,
  type LocalAgentStatusItem,
} from './local-runner.js';
import { getIpcWorkerStatus, type IpcWorkerStatus } from './ipc-worker.js';

/** 单条 IPC 队列的深度信息。 */
export interface QueueDepthItem {
  key: string;
  depth: number;
}

/** 运行时状态快照。 */
export interface RuntimeStatusSnapshot {
  performance: ReturnType<typeof getAgentPerformance>;
  /** 快照生成时间（ISO 8601）。 */
  generatedAt: string;
  /** 本实例管理的本地 agent-runtime 子进程。 */
  localAgents: LocalAgentStatusItem[];
  /** 本实例的 IPC 监听器与 pending 请求计数。 */
  ipc: IpcWorkerStatus;
  /** 有存活心跳的 runtime 账号（全局，来自 Redis）。 */
  heartbeatAccounts: string[];
  /** 非空的 inbox/outbox 队列及其深度（全局，来自 Redis）。 */
  queues: QueueDepthItem[];
  /** 全局并发闸门占用情况（全局，来自 Redis）。 */
  concurrency: {
    activeSlots: number;
    memberWaiters: number;
    normalWaiters: number;
  };
}

/** 扫描匹配 keyspace（游标分批），返回全部命中 key。 */
async function scanKeys(match: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, batch] = await getRedis().scan(
      cursor,
      'MATCH',
      match,
      'COUNT',
      200,
    );
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
}

/**
 * 采集一次完整的运行时状态快照。
 *
 * @returns 聚合后的只读快照；Redis 查询失败的分项以空值降级，不抛错。
 */
export async function collectRuntimeStatus(): Promise<RuntimeStatusSnapshot> {
  const redis = getRedis();

  // 队列深度：只列非空队列，避免面板被大量空 key 淹没。
  const queueKeys = await scanKeys('ipc:*:inbox*').then(async (inboxKeys) => [
    ...inboxKeys,
    ...(await scanKeys('ipc:*outbox')),
  ]);
  const queues: QueueDepthItem[] = [];
  for (const key of queueKeys) {
    const depth = await redis.llen(key).catch(() => 0);
    if (depth > 0) {
      queues.push({ key, depth });
    }
  }
  queues.sort((a, b) => b.depth - a.depth);

  const heartbeatKeys = await scanKeys('agent:heartbeat:*');
  const heartbeatAccounts = heartbeatKeys
    .map((key) => key.slice('agent:heartbeat:'.length))
    .sort();

  const [activeSlots, memberWaiters, normalWaiters] = await Promise.all([
    redis.zcard('agent:concurrency:active').catch(() => 0),
    redis.zcard('agent:concurrency:waitq:member').catch(() => 0),
    redis.zcard('agent:concurrency:waitq:normal').catch(() => 0),
  ]);

  return {
    performance: getAgentPerformance(),
    generatedAt: new Date().toISOString(),
    localAgents: getLocalAgentRuntimeStatus(),
    ipc: getIpcWorkerStatus(),
    heartbeatAccounts,
    queues,
    concurrency: { activeSlots, memberWaiters, normalWaiters },
  };
}
