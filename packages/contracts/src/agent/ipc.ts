import type {
  ChatInputKind,
  HistoryMessage,
  LlmRuntimeSnapshot,
  PiSessionBase,
  SessionBoardContext,
  UserPastedBoardInput,
} from './index.js';

export interface AgentInboxRequest {
  piSessionBase?: PiSessionBase | null;
  acceptedAtMs?: number;
  executionId?: string;
  type: 'chat' | 'task';
  requestId: string;
  accountId: string;
  timestamp: string;
  llmRuntime: LlmRuntimeSnapshot;
  userMessage: string;
  history: HistoryMessage[];
  inputKind?: ChatInputKind;
  pastedBoard?: UserPastedBoardInput;
  /** AI Chat 当前会话内的全部有效盘面上下文。 */
  sessionBoardContexts?: SessionBoardContext[];
  /** AI Chat 真实会话 ID，用于同一 session 内查找历史工具上下文。 */
  sessionId?: string;
  /** 本轮用户消息 ID；最终 assistant 消息用它派生稳定 ID。 */
  userMessageId?: string;
  /** 请求归属用户 ID；最终响应回传给宿主机用于独立落库。 */
  ownerUserId?: string;
  userName?: string;
  assistantName?: string;
  personaPrompt?: string;
  /** 本轮按单个 Skill id 授权（对外开放 API 用）；空数组=本轮不加载任何用户 Skill。 */
  authorizedSkillIds?: string[];
  /** 指定响应写入的 outbox 队列（不指定则用默认队列） */
  outboxQueue?: string;
}

/** AI Chat 取消请求 payload，用于通知 agent-runtime 中断指定 request。 */
export interface AgentCancelRequest {
  type: 'cancel';
  requestId: string;
  accountId: string;
  sessionId?: string;
  reason?: string;
  timestamp?: string;
}

// ─── Payload 接口 ─────────────────────────────────────

export interface SendMessageIpcPayload {
  type: 'message';
  eventId?: string;
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
  eventId?: string;
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
  eventId?: string;
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
