import {
  buildFunctionResponseContent,
  type GeminiClient,
  type GeminiContent,
  type GeminiGenerateContentRequest,
  type GeminiGenerateContentResponse,
  type GeminiPart,
} from './tools/skill/gemini-client.js';
import type {
  CompletionOptions,
  CompletionResult,
  LoopAdapter,
} from './base-loop.js';
import { roughTokenCount } from './loop/token-calibration.js';
import {
  ContextTrimmer,
  type MessageFormat,
  type TruncatableSegment,
} from './context-trimmer.js';
import { resolveCompletionMaxOutputTokens } from './output-token-policy.js';
import type { SystemPromptParts } from './prompt/index.js';
import type { ToolDefinition, ToolResult } from './types.js';

export interface GeminiFunctionCall {
  name: string;
  args: Record<string, unknown>;
}

function buildSystemInstruction(
  parts?: SystemPromptParts,
): GeminiGenerateContentRequest['systemInstruction'] {
  if (!parts) return undefined;
  const text = [parts.cached, parts.uncached]
    .filter((item) => item && item.trim())
    .join('\n\n');
  return text ? { parts: [{ text }] } : undefined;
}

function convertToolDefinitions(
  tools: ToolDefinition[],
): GeminiGenerateContentRequest['tools'] {
  if (tools.length === 0) return undefined;
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      })),
    },
  ];
}

function mapUsage(
  response: GeminiGenerateContentResponse,
): CompletionResult<GeminiFunctionCall>['usage'] {
  const usage = response.usageMetadata;
  if (!usage) return null;
  return {
    promptTokens: usage.promptTokenCount ?? 0,
    completionTokens: usage.candidatesTokenCount ?? 0,
  };
}

function extractToolCalls(parts: GeminiPart[]): GeminiFunctionCall[] {
  const calls: GeminiFunctionCall[] = [];
  for (const [index, part] of parts.entries()) {
    if (!part.functionCall) continue;
    calls.push({ name: part.functionCall.name, args: part.functionCall.args ?? {} });
  }
  return calls;
}

export class GeminiAdapter
  implements LoopAdapter<GeminiContent, GeminiFunctionCall>
{
  readonly providerName = 'gemini';
  private readonly trimmer: ContextTrimmer<GeminiContent>;

  constructor(
    private readonly client: GeminiClient,
    options: { protectedToolNames?: Set<string> } = {},
  ) {
    this.trimmer = new ContextTrimmer<GeminiContent>(geminiMessageFormat, {
      protectedToolNames: options.protectedToolNames,
    });
  }

  async createCompletion(
    messages: GeminiContent[],
    options: CompletionOptions,
  ): Promise<CompletionResult<GeminiFunctionCall>> {
    const request: GeminiGenerateContentRequest = {
      contents: messages,
      systemInstruction: buildSystemInstruction(options.systemPrompt),
      tools: convertToolDefinitions(options.tools ?? []),
      toolConfig:
        options.toolChoice === 'required'
          ? { functionCallingConfig: { mode: 'ANY' } }
          : { functionCallingConfig: { mode: 'AUTO' } },
      generationConfig: {
        temperature: options.temperature,
        maxOutputTokens: resolveCompletionMaxOutputTokens({
          model: options.model,
          configured: options.maxOutputTokens,
        }),
      },
    };
    const response = await this.client.generateContent(request, {
      signal: options.signal,
    });
    const candidate = response.candidates?.[0];
    if (!candidate) {
      throw new Error(
        `Gemini API 未返回任何候选 (candidates=${JSON.stringify(response.candidates)})`,
      );
    }
    const parts = candidate.content?.parts ?? [];
    return {
      toolCalls: extractToolCalls(parts),
      textContent: parts
        .filter((part): part is GeminiPart & { text: string } =>
          typeof part.text === 'string',
        )
        .map((part) => part.text)
        .join(''),
      finishReason: candidate.finishReason ?? null,
      usage: mapUsage(response),
      rawAssistantMessage: {
        role: 'model' as const,
        parts,
      },
    };
  }

  buildToolResultMessages(
    results: Array<{ toolCall: GeminiFunctionCall; result: ToolResult }>,
  ): GeminiContent[] {
    return [
      buildFunctionResponseContent(
        results.map(({ toolCall, result }) => ({
          name: toolCall.name,
          response: result.isError
            ? { error: result.modelOutput ?? result.output }
            : { output: result.modelOutput ?? result.output },
        })),
      ),
    ];
  }

  buildUserMessage(content: string): GeminiContent {
    return { role: 'user', parts: [{ text: content }] };
  }

  isStopDueToLength(
    result: CompletionResult<GeminiFunctionCall>,
  ): boolean {
    return result.finishReason === 'MAX_TOKENS';
  }

  isApiError(error: unknown): boolean {
    return error instanceof Error && error.message.includes('Gemini API');
  }

  getApiErrorStatus(error: unknown): number | undefined {
    if (!(error instanceof Error)) return undefined;
    const match = /Gemini API .*失败: (\d+)/.exec(error.message);
    return match ? Number.parseInt(match[1], 10) : undefined;
  }

  getApiErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  trimContextIfNeeded(
    messages: GeminiContent[],
    model: string,
    options: { aggressive?: boolean; contextWindowTokens?: number } = {},
  ): boolean {
    return this.trimmer.trimIfNeeded(messages, model, options);
  }

  getToolName(toolCall: GeminiFunctionCall): string {
    return toolCall.name;
  }

  getToolArgs(toolCall: GeminiFunctionCall): Record<string, unknown> {
    return toolCall.args;
  }
}

const geminiMessageFormat: MessageFormat<GeminiContent> = {
  estimateTokens(messages) {
    let total = 0;
    for (const msg of messages) {
      total += 4;
      for (const part of msg.parts) {
        total += roughTokenCount(JSON.stringify(part));
      }
    }
    return total;
  },

  role(msg) {
    return msg.role;
  },

  isRealUserMessage(msg) {
    return msg.parts.some((part) => typeof part.text === 'string');
  },

  toolCallEntries(msg) {
    if (msg.role !== 'model') return [];
    return msg.parts.flatMap((part, index) =>
      part.functionCall
        ? [{ id: `${part.functionCall.name}:${index}`, name: part.functionCall.name }]
        : [],
    );
  },

  toolResultIds(msg) {
    if (msg.role !== 'user') return [];
    return msg.parts.flatMap((part) =>
      part.functionResponse ? [part.functionResponse.name] : [],
    );
  },

  toolResultSegments(msg): TruncatableSegment[] {
    if (msg.role !== 'user') return [];
    const segments: TruncatableSegment[] = [];
    for (const part of msg.parts) {
      if (!part.functionResponse) continue;
      const response = part.functionResponse;
      segments.push({
        getText: () => JSON.stringify(response.response),
        setText: (text) => {
          response.response = { output: text };
        },
        toolId: response.name,
      });
    }
    return segments;
  },

  assistantTextSegments(msg): TruncatableSegment[] {
    if (msg.role !== 'model') return [];
    return msg.parts
      .filter((part): part is GeminiPart & { text: string } =>
        typeof part.text === 'string',
      )
      .map((part) => ({
        getText: () => part.text,
        setText: (text: string) => {
          part.text = text;
        },
      }));
  },

  isFullyTruncatedToolResult(msg, marker) {
    if (msg.role !== 'user' || msg.parts.length === 0) return false;
    return msg.parts.every((part) => {
      const response = part.functionResponse?.response;
      return (
        part.functionResponse !== undefined &&
        typeof response === 'object' &&
        response !== null &&
        (response as Record<string, unknown>).output === marker
      );
    });
  },
};
