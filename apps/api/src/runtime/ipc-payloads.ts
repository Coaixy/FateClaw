/**
 * IPC 消息类型定义与验证。
 * 所有 IPC payload 接口和 type guard 集中在此模块。
 */

import { getAllAccounts } from '../infrastructure/db.js';
import type { BillingReservation } from '../modules/billing/plans.js';
import { ScheduledTask } from '../shared/types.js';

// ─── 公共类型 ──────────────────────────────────────────

export type ReminderAction = 'pause' | 'resume' | 'cancel';

export interface InboxRequestResult {
  requestId: string;
  status: 'success' | 'error';
  text: string;
  assistantMessages?: string[];
  error?: string;
  publicErrorText?: string;
  publicReasonCode?: string;
  metadata?: unknown;
  skillContext?: Array<{
    skill: string;
    output: string;
    artifactType?: string;
    artifactTitle?: string;
    artifactData?: unknown;
  }>;
}

export interface LlmRuntimeSnapshot {
  source: 'custom' | 'official';
  billingMode: 'none' | 'metered';
  modelConfigId: string;
  piApi:
    | 'openai-completions'
    | 'openai-responses'
    | 'anthropic-messages'
    | 'google-generative-ai';
  model: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  apiKey: string;
  baseUrl?: string;
  authMode:
    | 'openai_api_key'
    | 'anthropic_api_key'
    | 'claude_code_oauth_token'
    | 'gemini_api_key';
  providerKey: string;
  inputTokenPricePerMillionCoins?: number;
  outputTokenPricePerMillionCoins?: number;
}

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
  llmRuntime?: LlmRuntimeSnapshot;
  billingReservation?: BillingReservation | null;
  priority?: InboxPriority;
  /** 全局并发槽位 ID；请求进入 agent 后持有，最终响应、取消或超时时释放。 */
  concurrencySlotId?: string;
  /** 请求提交到本机运行时的毫秒时间戳，用于计算最终回复耗时。 */
  startedAtMs?: number;
  resolve: (result: InboxRequestResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

/** AI Chat 取消请求 payload，用于通知 agent-runner 中断指定 request。 */
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
  };
}

export interface ResponseIpcPayload {
  type: 'response';
  accountId?: string;
  requestId?: string;
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

export interface ScheduleReminderIpcPayload {
  type: 'schedule_reminder';
  taskId?: string;
  accountId?: string;
  prompt?: string;
  schedule_type?: ScheduledTask['schedule_type'];
  schedule_value?: string;
  reminder_type?: ScheduledTask['reminder_type'];
  voice_text?: string;
  created_at?: string;
}

export interface ManageReminderIpcPayload {
  type: 'pause_reminder' | 'resume_reminder' | 'cancel_reminder';
  taskId?: string;
  accountId?: string;
  timestamp?: string;
}

// ─── 验证函数 ─────────────────────────────────────────

export function validateSchedulePayload(
  payload: unknown,
): payload is ScheduleReminderIpcPayload {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const record = payload as Record<string, unknown>;
  return (
    record.type === 'schedule_reminder' &&
    typeof record.taskId === 'string' &&
    typeof record.prompt === 'string' &&
    (record.schedule_type === 'cron' ||
      record.schedule_type === 'interval' ||
      record.schedule_type === 'once') &&
    typeof record.schedule_value === 'string'
  );
}

export function validateReminderActionPayload(
  payload: unknown,
): payload is ManageReminderIpcPayload {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const record = payload as Record<string, unknown>;
  return (
    (record.type === 'pause_reminder' ||
      record.type === 'resume_reminder' ||
      record.type === 'cancel_reminder') &&
    typeof record.taskId === 'string'
  );
}

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

  const accounts = await getAllAccounts();
  if (accounts.length === 1) {
    return accounts[0].id;
  }

  return null;
}
