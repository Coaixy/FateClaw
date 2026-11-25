/**
 * IPC 消息类型定义与验证。
 * 所有 IPC payload 接口和 type guard 集中在此模块。
 */

import type { PublicReasonCode } from '@fateclaw/contracts';

import { getSingleAccountIdIfOnlyOne } from '#infrastructure/db';
import type { BillingReservation } from '#modules/billing/plans';
import type { NormalizedRuntimeTokenUsage } from './token-usage.js';
import { InvalidAiChatPayloadError } from '#shared/ipc-errors';
export { InvalidAiChatPayloadError } from '#shared/ipc-errors';

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
  capacityToken?: string;
  /** 请求提交到本机运行时的毫秒时间戳，用于计算最终回复耗时。 */
  startedAtMs?: number;
  timings?: Array<{ type: 'agent_timing'; stage: string; durationMs: number }>;
  resolve: (result: InboxRequestResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

import type {
  ProgressIpcPayload,
  ResponseIpcPayload,
  SendMessageIpcPayload,
} from '@fateclaw/contracts/agent';
export type {
  AgentCancelRequest as CancelInboxRequestPayload,
  ProgressIpcPayload,
  ResponseIpcPayload,
  SendMessageIpcPayload,
} from '@fateclaw/contracts/agent';

// ─── 验证函数 ─────────────────────────────────────────

function validIdentityFields(record: Record<string, unknown>): boolean {
  return [
    'accountId',
    'requestId',
    'sessionId',
    'ownerUserId',
    'userMessageId',
    'eventId',
  ].every(
    (field) =>
      record[field] === undefined ||
      (typeof record[field] === 'string' && record[field].length > 0),
  );
}

export function validateMessagePayload(
  payload: unknown,
): payload is SendMessageIpcPayload {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const record = payload as Record<string, unknown>;
  return (
    record.type === 'message' &&
    typeof record.text === 'string' &&
    validIdentityFields(record)
  );
}

export function validateProgressPayload(
  payload: unknown,
): payload is ProgressIpcPayload {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const record = payload as Record<string, unknown>;
  return (
    record.type === 'progress' &&
    typeof record.text === 'string' &&
    validIdentityFields(record)
  );
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
    validIdentityFields(record) &&
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

export function bindIpcPayloadIdentity<
  T extends SendMessageIpcPayload | ProgressIpcPayload | ResponseIpcPayload,
>(
  payload: T,
  queueAccountId: string | undefined,
  pendingRequests: Map<string, PendingInboxRequest>,
): T {
  const pending = payload.requestId
    ? pendingRequests.get(payload.requestId)
    : undefined;
  const accountId = queueAccountId ?? pending?.accountId ?? payload.accountId;
  if (
    !accountId ||
    (payload.accountId !== undefined && payload.accountId !== accountId) ||
    (pending && pending.accountId !== accountId)
  )
    throw new InvalidAiChatPayloadError('IPC account mismatch');
  const record = payload as SendMessageIpcPayload;
  for (const field of ['sessionId', 'ownerUserId', 'userMessageId'] as const) {
    if (
      pending?.[field] !== undefined &&
      record[field] !== undefined &&
      pending[field] !== record[field]
    )
      throw new InvalidAiChatPayloadError('IPC request context mismatch');
  }
  return {
    ...payload,
    accountId,
    ...(pending?.sessionId ? { sessionId: pending.sessionId } : {}),
    ...(pending?.ownerUserId ? { ownerUserId: pending.ownerUserId } : {}),
    ...(pending?.userMessageId ? { userMessageId: pending.userMessageId } : {}),
  };
}
