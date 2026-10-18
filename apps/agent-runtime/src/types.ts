export { PUBLIC_REASON_CODES } from '@fateclaw/contracts';
export type { PublicReasonCode } from '@fateclaw/contracts';

/** 对话历史中的单条消息。 */
export type {
  HistoryMessage,
  ChatInputKind,
  UserPastedBoardInput,
  PiThinkingLevel,
  LlmRuntimeSnapshot,
} from '@fateclaw/contracts/agent';
import type {
  HistoryMessage,
  ChatInputKind,
  UserPastedBoardInput,
  LlmRuntimeSnapshot,
} from '@fateclaw/contracts/agent';

/** Request-scoped input passed from the Redis envelope into Pi. */
export interface ContainerInput {
  accountId: string;
  executionId?: string;
  sessionId?: string;
  /** 本次请求使用的显式 DB runtime 快照。 */
  llmRuntime: LlmRuntimeSnapshot;
  /** 用户当前消息。 */
  userMessage: string;
  /** 用户输入类型。normal 是普通聊天；user_pasted_board 只能来自专用自贴盘面入口。 */
  inputKind?: ChatInputKind;
  /** 用户通过自贴盘面入口提交的原始盘面文本和问题。 */
  pastedBoard?: UserPastedBoardInput;
  piSessionBase?: import('@fateclaw/contracts/agent').PiSessionBase | null;
  acceptedAtMs?: number;
  /** 当前会话内全部有效盘面；每轮由 FateClaw API 从 DB 重建后注入 Pi system context。 */
  sessionBoardContexts?: SessionBoardContext[];
  /** 结构化对话历史（按时间正序）。 */
  history: HistoryMessage[];
  /** 用户名称（用于 system prompt 人设）。 */
  userName?: string;
  /** AI 伴侣名称（用于 system prompt 人设）。 */
  assistantName?: string;
  /** 请求级 Persona 覆盖层；不是 Dashboard 维护的用户 Soul。 */
  personaPrompt?: string;
  /** 本轮按单个 Skill id 授权（对外开放 API 用）；空数组=本轮不加载任何用户 Skill。 */
  authorizedSkillIds?: string[];
  /** 指定响应写入的 outbox 队列，AI Chat 用于持久化工具进度。 */
  outboxQueue?: string;
}

export type { SessionBoardContext } from '@fateclaw/contracts/agent';
import type { SessionBoardContext } from '@fateclaw/contracts/agent';

export interface ChatTaskInboxRequest {
  piSessionBase?: import('@fateclaw/contracts/agent').PiSessionBase | null;
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

export type InboxRequest = ChatTaskInboxRequest;

/**
 * 宿主机请求中断正在执行的 AI Chat。
 *
 * requestId 用于匹配当前 agent-runtime 进程内的 active session。
 */
export interface CancelInboxRequest {
  type: 'cancel';
  requestId: string;
  accountId: string;
  sessionId?: string;
  reason?: string;
  timestamp?: string;
}

/** API 返回的真实 token 用量（多轮累加后的总和）。 */
export type { TokenUsage } from '@fateclaw/contracts/agent';
import type { TokenUsage } from '@fateclaw/contracts/agent';

/** 本次请求中产生的 skill 执行结果（跨请求保留用）。 */
export interface SkillContextEntry {
  skill: string;
  output: string;
  artifactType?: string;
  artifactTitle?: string;
  artifactData?: unknown;
}

export interface Artifact {
  id: string;
  type: string;
  title: string;
  producer: string;
  category?: string;
  payload: unknown;
  rawOutput: string;
  createdAt: string;
}

export interface AgentTaskNode {
  id: string;
  kind: 'root' | 'specialist';
  status: 'completed' | 'running' | 'blocked' | 'failed';
  source: 'supervisor';
  specialist?: string;
  goal: string;
  category?: string;
  startedAt: string;
  completedAt?: string;
  outputPreview?: string;
}

export interface AgentEvidenceNode {
  id: string;
  source: 'history' | 'artifact' | 'assistant_reply';
  category?: string;
  producer?: string;
  title: string;
  contentPreview: string;
  createdAt: string;
  artifactId?: string;
  payload?: unknown;
}

export interface AgentGraphEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  relation: 'uses' | 'delegates' | 'produces' | 'responds_with';
}

export interface AgentGraphSummary {
  category?: string;
  specialistSequence: string[];
  taskCount: number;
  evidenceCount: number;
  finalTextPreview?: string;
}

export interface AiChatStreamUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export type AiChatStreamEvent =
  | {
      type: 'connected';
      timestamp?: string;
      requestId?: string;
      accountId?: string;
      sessionId?: string;
    }
  | {
      type: 'agent_start' | 'agent_end' | 'turn_start';
      timestamp?: string;
      requestId?: string;
      accountId?: string;
      sessionId?: string;
      turnIndex?: number;
      willRetry?: boolean;
      messageCount?: number;
    }
  | {
      type: 'assistant_delta';
      timestamp?: string;
      requestId?: string;
      accountId?: string;
      sessionId?: string;
      delta: string;
      snapshot: string;
      turnIndex?: number;
    }
  | {
      type: 'thinking_delta';
      timestamp?: string;
      requestId?: string;
      accountId?: string;
      sessionId?: string;
      delta: string;
      snapshot: string;
      turnIndex?: number;
    }
  | {
      type: 'assistant_message';
      timestamp?: string;
      requestId?: string;
      accountId?: string;
      sessionId?: string;
      text: string;
      turnIndex?: number;
    }
  | {
      type: 'tool_start' | 'tool_update' | 'tool_end';
      timestamp?: string;
      requestId?: string;
      accountId?: string;
      sessionId?: string;
      toolCallId: string;
      toolName: string;
      args?: unknown;
      partialResult?: unknown;
      result?: unknown;
      isError?: boolean;
    }
  | {
      type: 'progress';
      timestamp?: string;
      requestId?: string;
      accountId?: string;
      sessionId?: string;
      text: string;
      stage?: string;
      workflow?: string;
      metadata?: unknown;
    }
  | {
      type: 'final';
      timestamp?: string;
      requestId?: string;
      accountId?: string;
      sessionId?: string;
      text: string;
      status: 'success' | 'error';
      usage?: AiChatStreamUsage;
      metadata?: unknown;
    }
  | {
      type: 'error';
      timestamp?: string;
      requestId?: string;
      accountId?: string;
      sessionId?: string;
      error: string;
      publicErrorText?: string;
      publicReasonCode?: string;
    }
  | {
      type: 'usage';
      timestamp?: string;
      requestId?: string;
      accountId?: string;
      sessionId?: string;
      usage: AiChatStreamUsage;
    };

export interface AiChatProgressOutboxMessage {
  type: 'progress';
  accountId?: string;
  requestId?: string;
  text: string;
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

export interface AgentTaskGraph {
  version: 1;
  requestId: string;
  accountId: string;
  sessionId?: string;
  rootTaskId: string;
  tasks: AgentTaskNode[];
  evidence: AgentEvidenceNode[];
  edges: AgentGraphEdge[];
  summary: AgentGraphSummary;
}

export interface ToolInvocation {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  source: 'model';
}

export interface TranscriptAssistantEvent {
  type: 'assistant';
  text: string;
}

export interface TranscriptToolUseEvent {
  type: 'tool_use';
  invocation: ToolInvocation;
}

export interface TranscriptToolResultEvent {
  type: 'tool_result';
  invocationId: string;
  ok: boolean;
  output: string;
  /** 实际回灌给模型的工具结果；为空时模型看到 output。 */
  modelOutput?: string;
  artifactId?: string;
}

export type TranscriptEvent =
  | TranscriptAssistantEvent
  | TranscriptToolUseEvent
  | TranscriptToolResultEvent;

/**
 * 结构化 trace 事件。由 traceEvent() 产生，按请求缓冲到 request-state，
 * 请求完成时经 ContainerOutput → OutboxResponse 回传给宿主机落库。
 *
 * 松约束设计：事件 schema 差异太大（request_start.promptPreview、
 * tool_call.args、loop_iteration.toolCalls[]
 * 等字段各不相同），强 union 维护成本高。type 和 timestamp 是稳定契约，
 * 其他字段由 traceEvent() 调用方自行约定。
 */
export type TraceEventEntry = Record<string, unknown> & {
  type: string;
  timestamp: string;
  requestId?: string;
  accountId?: string;
};

export type { PiSessionSnapshot } from '@fateclaw/contracts/agent';
import type { PiSessionSnapshot } from '@fateclaw/contracts/agent';

/**
 * 容器运行结束后回传给宿主机的结构。
 */
export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  publicErrorText?: string;
  publicReasonCode?: string;
  usage?: TokenUsage;
  /** 本次请求中确定性工具与解读工具产生的结构化结果，宿主机应存储以供后续请求使用。 */
  skillContext?: SkillContextEntry[];
  /** 本次请求的完整 transcript 日志（所有工具调用 + 结果），用于 debug。 */
  transcript?: TranscriptEvent[];
  /** 本次请求使用的模型名。 */
  model?: string;
  /** 本次请求使用的 AI provider。 */
  provider?: string;
  /** 本次请求的结构化 trace 事件序列，用于 admin 排障。 */
  traceEvents?: TraceEventEntry[];
  /** 本次请求的持久化 task/evidence graph。 */
  agentGraph?: AgentTaskGraph;
  /** Pi session 持久化状态与本轮完成后的消息快照。 */
  piSession?:
    | PiSessionSnapshot
    | import('@fateclaw/contracts/agent').PiSessionFrame;
}

export interface OutboxResponse {
  type: 'response';
  requestId: string;
  accountId: string;
  /** AI Chat 会话 ID；宿主机最终响应落库需要。 */
  sessionId?: string;
  /** 本轮用户消息 ID；宿主机用它派生最终 assistant 消息 ID。 */
  userMessageId?: string;
  /** 请求归属用户 ID；宿主机最终消息 user_id 兜底使用。 */
  ownerUserId?: string;
  text: string;
  status: 'success' | 'error';
  timestamp: string;
  error?: string;
  publicErrorText?: string;
  publicReasonCode?: string;
  usage?: TokenUsage;
  /** skill 执行结果，宿主机存储后注入后续请求的 history。 */
  skillContext?: SkillContextEntry[];
  /** 完整 transcript 日志。 */
  transcript?: TranscriptEvent[];
  /** 模型名。 */
  model?: string;
  /** AI provider。 */
  provider?: string;
  /** 结构化 trace 事件序列。 */
  traceEvents?: TraceEventEntry[];
  /** 持久化 task/evidence graph。 */
  agentGraph?: AgentTaskGraph;
  /** Pi session 持久化状态与本轮完成后的消息快照。 */
  piSession?:
    | PiSessionSnapshot
    | import('@fateclaw/contracts/agent').PiSessionFrame;
  /** 结构化响应标识，例如最终回复完成标记。 */
  metadata?: unknown;
}
