/**
 * IPC 消息类型定义与验证。
 * 所有 IPC payload 接口和 type guard 集中在此模块。
 */

import type { PublicReasonCode } from '@fateclaw/contracts';

import { getSingleAccountIdIfOnlyOne } from '../infrastructure/db.js';
import { getRedis } from '../infrastructure/redis.js';
import type { BillingReservation } from '../modules/billing/plans.js';
import type { NormalizedRuntimeTokenUsage } from './token-usage.js';

// ─── 公共类型 ──────────────────────────────────────────

export interface InboxRequestResult {
  requestId: string;
  status: 'success' | 'error';
  text: string;
  assistantMessages?: string[];
  error?: string;
  publicErrorText?: string;
  publicReasonCode?: string;
  metadata?: unknown;
  /** 本次请求的真实 token 用量（归一化口径，与计费一致）；provider 未上报时为全 0。 */
  usage?: NormalizedRuntimeTokenUsage;
  skillContext?: Array<{
    skill: string;
    output: string;
    artifactType?: string;
    artifactTitle?: string;
    artifactData?: unknown;
  }>;
}

export type { LlmRuntimeSnapshot } from '@fateclaw/contracts/agent';
import type { LlmRuntimeSnapshot } from '@fateclaw/contracts/agent';

export type InboxPriority = 'normal' | 'member';

/**
 * 构造 AI Chat 会话忙碌锁的 Redis key。
 *
 * @param sessionId AI Chat 会话 ID。
 * @returns 对应的 Redis key。
 */
export function sessionProcessingLockKey(sessionId: string): string {
  return `session:processing:${sessionId}`;
}

/**
 * 抢占或续期当前请求拥有的会话忙碌锁。
 *
 * @param sessionId AI Chat 会话 ID；为空时直接返回 false。
 * @param requestId 锁 owner，请求 ID 必须与锁内值一致才允许续期。
 * @param ttlSeconds 锁 TTL 秒数。
 * @returns 抢占空锁或续期自有锁成功时返回 true；锁被其他请求持有时返回 false。
 */
export async function claimOrRefreshSessionProcessingLock(
  sessionId: string | undefined,
  requestId: string | undefined,
  ttlSeconds: number,
): Promise<boolean> {
  if (!sessionId || !requestId) return false;
  const claimed = await getRedis().eval(
    `
    local current = redis.call('GET', KEYS[1])
    if current == ARGV[1] then
      return redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
    end
    if not current then
      redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2]))
      return 1
    end
    return 0
    `,
    1,
    sessionProcessingLockKey(sessionId),
    requestId,
    ttlSeconds,
  );
  return claimed === 1;
}

/**
 * 仅释放当前请求拥有的会话忙碌锁。
 *
 * @param sessionId AI Chat 会话 ID；为空时不操作。
 * @param requestId 期望的锁 owner，请求 ID 必须与锁内值一致才会删除。
 * @returns 实际删除 Redis key 时返回 true，否则返回 false。
 */
export async function releaseSessionProcessingLock(
  sessionId: string | undefined,
  requestId: string | undefined,
): Promise<boolean> {
  if (!sessionId || !requestId) return false;
  const released = await getRedis().eval(
    `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('DEL', KEYS[1])
    end
    return 0
    `,
    1,
    sessionProcessingLockKey(sessionId),
    requestId,
  );
  return released === 1;
}

export interface PendingInboxRequest {
  accountId: string;
  /** 请求归属的平台用户。站内 AI Chat 用运行时键，不再从 accounts 反查。 */
  ownerUserId?: string;
  toUserId?: string;
  contextToken?: string;
  autoDeliver: boolean;
  /**
   * AI 对话会话 ID。autoDeliver=false 时，agent 通过 send_message 推出的
   * 中间消息会带上该 sessionId 存入 messages 表，web 前端能 reload 看到；
   * autoDeliver=true（微信场景）时为 undefined。
   */
  sessionId?: string;
  /** 本轮用户消息 ID；最终 assistant 消息用它派生稳定 ID，避免重复落库。 */
  userMessageId?: string;
  /** session:processing 锁内保存的 owner 值，必须与当前请求 ID 一致后才可释放。 */
  sessionProcessingRequestId?: string;
  llmRuntime?: LlmRuntimeSnapshot;
  billingReservation?: BillingReservation | null;
  priority?: InboxPriority;
  /** 全局并发槽位 ID；请求进入 agent 后持有，最终响应、取消或超时时释放。 */
  concurrencySlotId?: string;
  /** Opaque lease for the exact local child; released on completion, cancellation or timeout. */
  localAgentLeaseId?: string;
  /** 请求提交到本机运行时的毫秒时间戳，用于计算最终回复耗时。 */
  startedAtMs?: number;
  resolve: (result: InboxRequestResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

/** AI Chat 取消请求 payload，用于通知 agent-runtime 中断指定 request。 */
export interface CancelInboxRequestPayload {
  type: 'cancel';
  requestId?: string;
  accountId?: string;
  sessionId?: string;
  reason?: string;
  timestamp?: string;
}

// ─── Payload 接口 ─────────────────────────────────────

export interface SendMessageIpcPayload {
  type: 'message';
  accountId?: string;
  requestId?: string;
  /** AI Chat 会话 ID；最终响应可在没有本机 pending 时独立落库。 */
  sessionId?: string;
  /** 本轮用户消息 ID；最终 assistant 消息用它派生稳定 ID。 */
  userMessageId?: string;
  /** 请求归属用户 ID；用于最终消息 user_id 和用量归属兜底。 */
  ownerUserId?: string;
  text?: string;
  timestamp?: string;
  metadata?: unknown;
  /** 中间消息携带的 skill 上下文，用于 AI Chat 渲染盘面卡片。 */
  skillContext?: Array<{
    skill: string;
    output: string;
    artifactType?: string;
    artifactTitle?: string;
    artifactData?: unknown;
  }>;
}

export interface ProgressIpcPayload {
  type: 'progress';
  accountId?: string;
  requestId?: string;
  text?: string;
  timestamp?: string;
  metadata?: {
    kind?: string;
    stage?: string;
    workflow?: string;
    tool_call_id?: string;
    tool_name?: string;
    tool_label?: string;
    tool_status?: 'running' | 'completed' | 'failed';
    tool_path?: string;
    /** 工具输入摘要 / 搜索词，用作富卡片标题。 */
    query_text?: string;
    /** 所属 agent 回合序号；思考块稳定 id 与穿插排序用。 */
    turn_index?: number;
    /** 工具调用结果预览（已归一化限长），供历史富卡片回看。 */
    tool_result?: {
      query?: string;
      count?: number;
      items?: Array<{ title: string; url?: string; domain?: string }>;
      text?: string;
      truncated?: boolean;
    };
  };
}

export interface ResponseIpcPayload {
  type: 'response';
  accountId?: string;
  requestId?: string;
  /** AI Chat 会话 ID；最终响应可在没有本机 pending 时独立落库。 */
  sessionId?: string;
  /** 本轮用户消息 ID；最终 assistant 消息用它派生稳定 ID。 */
  userMessageId?: string;
  /** 请求归属用户 ID；用于最终消息 user_id 和用量归属兜底。 */
  ownerUserId?: string;
  text?: string;
  assistantMessages?: string[];
  status?: 'success' | 'error';
  error?: string;
  publicErrorText?: string;
  publicReasonCode?: string;
  timestamp?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  /** 容器返回的 skill 执行结果，存入 DB 供后续请求使用。 */
  skillContext?: Array<{
    skill: string;
    output: string;
    artifactType?: string;
    artifactTitle?: string;
    artifactData?: unknown;
  }>;
  /** 完整 transcript 日志（工具调用 + 结果），用于 debug。 */
  transcript?: unknown[];
  /** 模型名。 */
  model?: string;
  /** AI provider。 */
  provider?: string;
  /** 结构化 trace 事件序列（主 loop、工具调用、错误等），用于 admin 排障。 */
  traceEvents?: unknown[];
  /** 持久化 task/evidence graph。 */
  agentGraph?: unknown;
  /** Pi session 持久化状态与本轮完成后的消息快照。 */
  piSession?: unknown;
  /** 结构化响应标识，例如最终回复完成标记。 */
  metadata?: unknown;
}

// ─── 验证函数 ─────────────────────────────────────────

export function validateMessagePayload(
  payload: unknown,
): payload is SendMessageIpcPayload {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const record = payload as Record<string, unknown>;
  return record.type === 'message' && typeof record.text === 'string';
}

export function validateProgressPayload(
  payload: unknown,
): payload is ProgressIpcPayload {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const record = payload as Record<string, unknown>;
  return record.type === 'progress' && typeof record.text === 'string';
}

export function validateResponsePayload(
  payload: unknown,
): payload is ResponseIpcPayload {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const record = payload as Record<string, unknown>;
  return (
    record.type === 'response' &&
    typeof record.requestId === 'string' &&
    typeof record.text === 'string' &&
    (record.status === 'success' || record.status === 'error')
  );
}

// ─── 工具函数 ─────────────────────────────────────────

/**
 * 构造一条 AI Chat「错误响应」outbox payload。
 *
 * 三处失败兜底——本地 agent 进程崩溃、请求提交失败、inbox 堆积超时——此前各自
 * 手工拼装同型 payload，极易漏掉 {@link validateResponsePayload} 要求的必填
 * `text` 字段；一漏，整条 payload 会被判为无效格式抛出、兜底静默失效，用户
 * 收不到任何错误提示（正是「发送后卡在正在回复、无内容」事故的一环）。统一从
 * 这里出口，把 `text` 兜底为面向用户的 `publicErrorText`，保证必填字段只在
 * 一处保证，杜绝漏传。
 *
 * @param params.publicErrorText 面向用户的错误文案；同时兜底为必填的 `text`。
 * @param params.error 内部诊断信息（退出码/异常等），仅入库供排障，不直接暴露。
 * @param params.reasonCode 机器可读的失败原因码（如 `agent_process_exited`）。
 * @returns 一条通过 {@link validateResponsePayload} 校验的 error 响应 payload。
 */
export function buildAiChatErrorResponsePayload(params: {
  accountId: string;
  requestId: string;
  sessionId?: string;
  userMessageId?: string;
  ownerUserId?: string;
  publicErrorText: string;
  error: string;
  /** 机器可读的失败原因码，编译期收窄到 contracts 约定的取值集合。 */
  reasonCode: PublicReasonCode;
  usage?: ResponseIpcPayload['usage'];
  syntheticTerminal?: boolean;
}): ResponseIpcPayload {
  return {
    type: 'response',
    accountId: params.accountId,
    requestId: params.requestId,
    sessionId: params.sessionId,
    userMessageId: params.userMessageId,
    ownerUserId: params.ownerUserId,
    status: 'error',
    // text 是 validateResponsePayload 的必填字段，统一兜底为用户可见文案，
    // 避免任何调用方漏传导致 payload 被判无效、错误提示静默丢失。
    text: params.publicErrorText,
    error: params.error,
    publicErrorText: params.publicErrorText,
    publicReasonCode: params.reasonCode,
    timestamp: new Date().toISOString(),
    usage: params.usage,
    ...(params.syntheticTerminal
      ? { metadata: { synthetic_terminal: true } }
      : {}),
  };
}

export async function resolveAccountId(
  explicitAccountId: unknown,
  fallbackAccountId?: string,
): Promise<string | null> {
  if (typeof explicitAccountId === 'string' && explicitAccountId.trim()) {
    return explicitAccountId.trim();
  }

  if (fallbackAccountId) {
    return fallbackAccountId;
  }

  return getSingleAccountIdIfOnlyOne();
}

export class InvalidAiChatPayloadError extends Error {}
