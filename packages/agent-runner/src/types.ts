import OpenAI from 'openai';

/** 对话历史中的单条消息。 */
export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
  /** 结构化工具/skill 结果，供模型上下文复用。 */
  toolContext?: SkillContextEntry[];
}

export type ChatInputKind = 'normal' | 'user_pasted_board';

export interface UserPastedBoardInput {
  category: string;
  content: string;
  question: string;
}

export interface LlmRuntimeSnapshot {
  source: 'custom' | 'official';
  billingMode: 'none' | 'metered';
  modelConfigId: string;
  provider: 'openai-compatible' | 'openai-response' | 'anthropic' | 'gemini';
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
  inputTokenPricePerMillionPoints?: number;
  outputTokenPricePerMillionPoints?: number;
}

/** 宿主机通过 stdin 传给容器的输入。 */
export interface ContainerInput {
  accountId: string;
  sessionId?: string;
  /** 本次请求使用的显式 DB runtime 快照。 */
  llmRuntime: LlmRuntimeSnapshot;
  /** 用户当前消息。 */
  userMessage: string;
  /** 用户输入类型。normal 是普通聊天；user_pasted_board 只能来自专用自贴盘面入口。 */
  inputKind?: ChatInputKind;
  /** 用户通过自贴盘面入口提交的原始盘面文本和问题。 */
  pastedBoard?: UserPastedBoardInput;
  /** 当前明确选中的盘面。存在时，本轮按该盘面继续解读。 */
  activeBoardContext?: ActiveBoardContext;
  /** 结构化对话历史（按时间正序）。 */
  history: HistoryMessage[];
  /** 用户名称（用于 system prompt 人设）。 */
  userName?: string;
  /** AI 伴侣名称（用于 system prompt 人设）。 */
  assistantName?: string;
  /** Persona 人格覆盖层：由创作者定义，会追加到 system prompt 头部。 */
  personaPrompt?: string;
}

export interface ActiveBoardContext extends SkillContextEntry {
  sourceMessageId: string;
}

export interface ChatTaskInboxRequest {
  type: 'chat' | 'task';
  requestId: string;
  accountId: string;
  timestamp: string;
  llmRuntime: LlmRuntimeSnapshot;
  userMessage: string;
  history: HistoryMessage[];
  inputKind?: ChatInputKind;
  pastedBoard?: UserPastedBoardInput;
  /** AI Chat 当前选中的盘面上下文。 */
  activeBoardContext?: ActiveBoardContext;
  /** AI Chat 真实会话 ID，用于同一 session 内查找历史工具上下文。 */
  sessionId?: string;
  userName?: string;
  assistantName?: string;
  personaPrompt?: string;
  /** 指定响应写入的 outbox 队列（不指定则用默认队列） */
  outboxQueue?: string;
}

export interface PaipanInboxRequest {
  type: 'paipan';
  requestId: string;
  accountId: string;
  timestamp: string;
  userId: string;
  skillDir: string;
  input: Record<string, unknown>;
  displayTitle?: string;
  /** 指定响应写入的 outbox 队列（不指定则用默认队列） */
  outboxQueue?: string;
}

export type InboxRequest = ChatTaskInboxRequest | PaipanInboxRequest;

/** API 返回的真实 token 用量（多轮累加后的总和）。 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

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

export interface ArtifactHint {
  type: string;
  title: string;
  producer?: string;
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
  source: 'history' | 'artifact' | 'final_reply';
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
  displayTitle?: string;
  artifactHint?: ArtifactHint;
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
  errorCode?: ToolErrorCode;
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
  /** 若为 true，宿主机应清除该账号的对话历史。 */
  clearHistory?: boolean;
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
}

export interface OutboxResponse {
  type: 'response';
  requestId: string;
  accountId: string;
  text: string;
  status: 'success' | 'error';
  timestamp: string;
  error?: string;
  publicErrorText?: string;
  publicReasonCode?: string;
  usage?: TokenUsage;
  /** skill 执行结果，宿主机存储后注入后续请求的 history。 */
  skillContext?: SkillContextEntry[];
  /** 若为 true，宿主机应清除该账号的对话历史。 */
  clearHistory?: boolean;
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
  /** 结构化响应标识，例如最终回复完成标记。 */
  metadata?: unknown;
}

/** OpenAI Chat Completions 消息类型别名。 */
export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

// ---------------------------------------------------------------------------
// Tool 类型定义
// ---------------------------------------------------------------------------

/** OpenAI function calling 工具定义 schema。 */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

/** 工具错误的稳定错误码。优先给上层 runtime / supervisor 消费，避免依赖文案匹配。 */
export type ToolErrorCode =
  | 'SKILL.PARAM_MISSING'
  | 'SKILL.PARAM_INVALID'
  | 'SKILL.DUPLICATE_SAME_LOOP'
  | 'SKILL.NOT_FOUND'
  | 'SKILL.NOT_ENABLED'
  | 'SKILL.SCRIPT_NOT_FOUND'
  | 'SKILL.SCRIPT_UNSUPPORTED'
  | 'SKILL.SCRIPT_TIMEOUT'
  | 'SKILL.SCRIPT_CRASH'
  | 'SKILL.INVALID_NAME'
  | 'SKILL.REQUEST_SCOPE_MISSING'
  | 'SKILL.CONTENT_MISSING'
  | 'SYSTEM.EMPTY_OUTPUT'
  | 'SYSTEM.PROTOCOL'
  | 'SYSTEM.INTERNAL';

/** 工具错误的大类，便于 supervisor / trace 做粗粒度分流。 */
export type ToolErrorKind =
  | 'validation'
  | 'dependency'
  | 'conflict'
  | 'not_found'
  | 'availability'
  | 'timeout'
  | 'execution'
  | 'internal';

/** 工具错误后建议的下一步动作。 */
export type ToolErrorNextAction =
  | 'ask_user'
  | 'fix_arguments'
  | 'retry'
  | 'retry_next_turn'
  | 'stop';

/** 工具错误的结构化负载。 */
export interface ToolErrorInfo {
  code: ToolErrorCode;
  kind: ToolErrorKind;
  retryable: boolean;
  /** 是否可以把 userMessage 直接面向用户暴露。 */
  userSafe: boolean;
  nextAction: ToolErrorNextAction;
  /** 若可安全暴露给用户，这里提供建议文案。 */
  userMessage?: string;
  /** 内部排障使用的原始错误说明。 */
  internalMessage: string;
  /** 额外上下文，供 trace / supervisor 精准处理。 */
  details?: Record<string, unknown>;
}

/** 工具执行结果。 */
export interface ToolResult {
  output: string;
  /**
   * 回灌给模型继续推理的工具结果。为空时使用 output。
   * 用于把结构化原始产物留给 artifact/tool_context，同时给模型更省 token 的确定性文本。
   */
  modelOutput?: string;
  isError?: boolean;
  /**
   * 结构化错误信息。通常与 isError=true 一起出现；
   * 某些“安全跳过但无实际产出”的场景（如重复调用跳过）也会附带 error 供上层识别。
   */
  error?: ToolErrorInfo;
  /** 工具内部额外消耗的 token，会并入本次请求总 usage。 */
  usage?: TokenUsage;
  /** 跳过 artifact/skillContext 生成，用于重复调用等非真实产出。 */
  skipArtifact?: boolean;
  /**
   * 交付语义：
   * - normal: 默认行为，工具结果回填给主 loop，由主模型继续编排/总结
   * - final: 工具结果本身已是可直接交付给用户的最终文案；满足运行时安全条件时，主 loop 可跳过 final_reply 直接返回
   */
  delivery?: 'normal' | 'final';
  /**
   * 标记此工具结果为"直通安全"，即该工具是纯查询/辅助性质，
   * 不应阻止 delivery: 'final' 工具的直通交付。
   * 用于知识库检索等只读工具场景。
   */
  passthroughSafe?: boolean;
}

export type ToolExecutionMode = 'parallel' | 'serial' | 'exclusive';

export interface ToolExecutionOptions {
  signal?: AbortSignal;
  requestScope?: import('./request-scope.js').RequestScope;
  /** 当前 agent-loop 的轮次编号；用于把重复调用保护限制在单轮内。 */
  loopIteration?: number;
  /** 当前 agent-loop 实例 ID；用于隔离不同 specialist / supervisor 的独立循环。 */
  loopRunId?: string;
  /** 测试/fixture 场景下覆盖 skill 根目录，生产路径不传。 */
  skillsDirOverride?: string;
  runtimeDeps?: import('./deps.js').AgentRuntimeDeps;
  /**
   * Supervisor 委派给 specialist 时的原始 goal 文本。
   * 用于 interpret_xuanxue 等工具在用户自贴场景下获取完整的原始信息。
   */
  delegationGoal?: string;
  /** 当前 agent-loop 使用的 provider。 */
  provider?: string;
  /** 当前 agent-loop 使用的 model。 */
  model?: string;
  /** 当前 agent-loop 使用的显式 DB runtime 快照。 */
  llmRuntime?: LlmRuntimeSnapshot;
  /** 当前请求输入类型，用于禁止普通聊天消息伪装成用户自贴盘面。 */
  inputKind?: ChatInputKind;
  /** 当前请求的用户自贴盘面数据，只能来自专用入口。 */
  pastedBoard?: UserPastedBoardInput;
  /** 当前请求中用户显式选中的官方盘面。 */
  activeBoardContext?: ActiveBoardContext;
  /** 当前请求归属用户，用于 Pi custom tool 执行层做二次鉴权。 */
  userId?: string;
}

/**
 * 工具规格：定义 + 富文本提示词 + 执行函数。
 * 每个工具文件导出一个 ToolSpec 实例。
 */
export interface ToolSpec {
  /** OpenAI function calling schema。 */
  definition: ToolDefinition;
  /** 注入 system prompt 的富文本说明。 */
  prompt: string;
  /** 工具调度语义。未声明时默认为 parallel。 */
  executionMode?: ToolExecutionMode;
  /** 工具执行函数。 */
  execute: (
    args: Record<string, unknown>,
    options?: ToolExecutionOptions,
  ) => Promise<ToolResult>;
}
