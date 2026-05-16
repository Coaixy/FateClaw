import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

import {
  createGeminiClient,
  buildSystemInstruction,
  buildUserContent,
  extractText,
} from './gemini-client.js';
import type { LlmRuntimeSnapshot } from '../../types.js';

export type BoardSource =
  | 'current_request_artifact'
  | 'active_board_context'
  | 'historical_artifact'
  | 'historical_board_output'
  | 'explicit_user_board'
  | 'model_content_fallback';

export interface BoardCandidate {
  source:
    | 'current_request_artifact'
    | 'historical_artifact'
    | 'historical_board_output'
    | 'model_content';
  content: string;
  skillName?: string;
}

export interface BoardResolverInput {
  currentUserMessage: string;
  question?: string;
  contextHints?: {
    contentSource?: string;
    category?: string | null;
    followupMode?: string;
  } | null;
  candidates: BoardCandidate[];
  delegationGoalContext?: string;
  historicalInterpretationOutput?: string;
}

export interface BoardResolutionResult {
  selectedSource: BoardSource;
  reason: string;
  confidence: number;
}

const RESOLVER_SELECTED_SOURCES = [
  'current_request_artifact',
  'historical_artifact',
  'historical_board_output',
  'model_content_fallback',
] as const satisfies readonly BoardSource[];

type ResolverSelectedSource = (typeof RESOLVER_SELECTED_SOURCES)[number];

function isResolverSelectedSource(
  value: unknown,
): value is ResolverSelectedSource {
  return (
    typeof value === 'string' &&
    RESOLVER_SELECTED_SOURCES.includes(value as ResolverSelectedSource)
  );
}

function buildCandidatePreview(content: string, maxChars = 1500): string {
  const trimmed = content.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}…`;
}

function buildSystemPromptText(): string {
  return [
    '你是盘面来源选择器。',
    '你的任务不是解读，而是从给定候选中选出本轮 interpret_xuanxue 应该使用的盘面来源。',
    '必须只输出 JSON，不要输出任何额外文字。',
    '输出字段：selectedSource, reason, confidence。',
    'selectedSource 只能取：',
    JSON.stringify([
      'current_request_artifact',
      'historical_artifact',
      'historical_board_output',
      'model_content_fallback',
    ]),
    '规则：',
    '1. 当前普通消息不能被选为用户自贴盘面来源；自贴盘面只来自专用 inputKind=user_pasted_board 协议入口，不经过本 resolver。',
    '2. delegationGoalContext 仅用于理解委派目标，永远不是可选盘面来源。',
    '3. 如果历史或本轮已有官方盘面，优先从这些官方盘面候选中选择。',
    '4. 只有在没有更可靠盘面时，才选 model_content_fallback；后续校验会拒绝没有官方盘面来源的解读。',
    '5. 不能编造新来源，必须从现有候选对应的语义中做选择。',
  ].join('\n');
}

function buildUserPromptText(input: BoardResolverInput): string {
  return JSON.stringify(
    {
      currentUserMessage: input.currentUserMessage,
      question: input.question,
      contextHints: input.contextHints,
      delegationGoalContext: input.delegationGoalContext,
      historicalInterpretationOutput: input.historicalInterpretationOutput,
      candidates: input.candidates.map((candidate) => ({
        source: candidate.source,
        skillName: candidate.skillName,
        preview: buildCandidatePreview(candidate.content),
        bytes: candidate.content.length,
      })),
    },
    null,
    2,
  );
}

export async function resolveBoardSourceWithLLM(
  input: BoardResolverInput,
  llmRuntime: LlmRuntimeSnapshot,
): Promise<BoardResolutionResult> {
  if (llmRuntime.provider === 'anthropic') {
    const response = await new Anthropic({
      apiKey:
        llmRuntime.authMode === 'anthropic_api_key'
          ? llmRuntime.apiKey
          : null,
      authToken:
        llmRuntime.authMode === 'claude_code_oauth_token'
          ? llmRuntime.apiKey
          : null,
      baseURL: llmRuntime.baseUrl,
      maxRetries: 2,
      timeout: 120_000,
    }).messages.create({
      model: llmRuntime.model,
      system: buildSystemPromptText(),
      temperature: 0,
      max_tokens: 600,
      messages: [{ role: 'user', content: buildUserPromptText(input) }],
    });
    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    return parseBoardResolverJson(text);
  }

  if (
    llmRuntime.provider === 'openai-compatible' ||
    llmRuntime.provider === 'openai-response'
  ) {
    const client = new OpenAI({
      apiKey: llmRuntime.apiKey,
      baseURL: llmRuntime.baseUrl,
      maxRetries: 2,
      timeout: 120_000,
    });

    if (llmRuntime.provider === 'openai-response') {
      const response = await client.responses.create({
        model: llmRuntime.model,
        instructions: buildSystemPromptText(),
        temperature: 0,
        max_output_tokens: 600,
        input: buildUserPromptText(input),
        text: { format: { type: 'json_object' } },
      });
      const text = response.output_text ?? '';
      return parseBoardResolverJson(text);
    }

    const response = await client.chat.completions.create({
      model: llmRuntime.model,
      temperature: 0,
      max_tokens: 600,
      messages: [
        { role: 'system', content: buildSystemPromptText() },
        { role: 'user', content: buildUserPromptText(input) },
      ],
    });
    const text = response.choices?.[0]?.message?.content ?? '';
    return parseBoardResolverJson(text);
  }

  const client = createGeminiClient({
    apiKey: llmRuntime.apiKey,
    baseURL: llmRuntime.baseUrl ?? 'https://generativelanguage.googleapis.com',
    model: llmRuntime.model,
  });

  const responseSchema = {
    type: 'object',
    properties: {
      selectedSource: { type: 'string', enum: RESOLVER_SELECTED_SOURCES },
      reason: { type: 'string' },
      confidence: { type: 'number' },
    },
    required: ['selectedSource', 'reason', 'confidence'],
  };

  const response = await client.generateContent({
    contents: [buildUserContent(buildUserPromptText(input))],
    systemInstruction: buildSystemInstruction(buildSystemPromptText()),
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema },
  });

  const content = extractText(response);
  if (!content) throw new Error('board resolver 未返回内容');
  return parseBoardResolverJson(content);
}

function parseBoardResolverJson(content: string): BoardResolutionResult {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    throw new Error(
      `board resolver 返回非 JSON 内容（已截断 200 字符）：${content.slice(0, 200)}`,
    );
  }
  const selectedSource = parsed.selectedSource;
  if (!isResolverSelectedSource(selectedSource)) {
    throw new Error(`board resolver 返回了无效来源: ${String(selectedSource)}`);
  }
  const confidenceRaw = parsed.confidence;
  return {
    selectedSource,
    reason: typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim() : 'board resolver 未提供原因',
    confidence: typeof confidenceRaw === 'number' ? Math.max(0, Math.min(1, confidenceRaw)) : 0.5,
  };
}
