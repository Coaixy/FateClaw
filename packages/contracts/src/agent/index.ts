export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
  /** 结构化工具/skill 结果，供模型上下文复用。 */
  toolContext?: Array<{
    skill: string;
    output: string;
    artifactType?: string;
    artifactTitle?: string;
    artifactData?: unknown;
  }>;
}

export type ChatInputKind = 'normal' | 'user_pasted_board';

export interface UserPastedBoardInput {
  category: string;
  content: string;
  question: string;
}

/** Pi runtime 可选的思考等级，缺省时由 runtime 按 medium 处理。 */
export const PI_THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const;
export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

export interface LlmRuntimeSnapshot {
  poolKey?: import('@fateclaw/contracts/model-settings').ModelPoolKey;
  poolRevision?: number;
  benefitPolicy?: import('@fateclaw/contracts/model-settings').BenefitPolicyDto;
  benefitRequestId?: string;
  poolNodes?: import('@fateclaw/contracts/model-settings').RuntimeModelPoolNode[];
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
  thinkingLevel?: PiThinkingLevel;
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

export interface SessionBoardContext {
  sourceMessageId: string;
  source: 'official_paipan' | 'user_pasted_board';
  skill: string;
  artifactTitle?: string;
  promptText: string;
  artifactData?: unknown;
  createdAt?: string;
  isCurrent?: boolean;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface PiSessionSnapshot {
  format?: never;
  id?: string;
  file?: string;
  persisted: boolean;
  provider: string;
  model: string;
  userPrompt: string;
  systemPrompt: string;
  appendSystemPrompt: string[];
  allowedTools: string[];
  readableSkills: Array<{
    name: string;
    description?: string;
  }>;
  messageCount: number;
  messages: unknown[];
}

export interface PiSessionBase {
  requestId: string;
  messagesHash: string;
  messageCount: number;
  checkpointDepth: number;
}

export interface PiSessionFrame extends Omit<PiSessionSnapshot, 'format'> {
  format: 'fateclaw-pi-frame-v1';
  kind: 'checkpoint' | 'delta';
  base?: PiSessionBase;
  messagesHash: string;
  checkpointDepth: number;
}

export interface AgentRequestData {
  accountId: string;
  userMessage: string;
  history: HistoryMessage[];
  sessionId?: string;
  inputKind?: ChatInputKind;
  pastedBoard?: UserPastedBoardInput;
  sessionBoardContexts?: SessionBoardContext[];
  userName?: string;
  assistantName?: string;
  personaPrompt?: string;
  authorizedSkillIds?: string[];
  outboxQueue?: string;
  piSessionBase?: PiSessionBase | null;
  acceptedAtMs?: number;
}
