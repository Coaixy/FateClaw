import OpenAI from 'openai';

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
import { toOpenAIStrictParameters } from './openai-strict-schema.js';
import { resolveCompletionMaxOutputTokens } from './output-token-policy.js';
import type { SystemPromptParts } from './prompt/index.js';
import type { ToolDefinition, ToolResult } from './types.js';

type ResponseInputItem = OpenAI.Responses.ResponseInputItem;
type Response = OpenAI.Responses.Response;
type ResponseFunctionToolCall = OpenAI.Responses.ResponseFunctionToolCall;

function buildInstructions(parts?: SystemPromptParts): string | undefined {
  if (!parts) return undefined;
  const text = [parts.cached, parts.uncached]
    .filter((part) => part && part.trim())
    .join('\n\n');
  return text || undefined;
}

function buildInputText(content: string): OpenAI.Responses.ResponseInputText {
  return { type: 'input_text', text: content };
}

function convertToolDefinitions(
  tools: ToolDefinition[],
): OpenAI.Responses.FunctionTool[] {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: toOpenAIStrictParameters(tool.function.parameters),
    strict: true,
  }));
}

function extractOutputText(response: Response): string {
  return response.output
    .filter(
      (item): item is OpenAI.Responses.ResponseOutputMessage =>
        item.type === 'message',
    )
    .flatMap((message) => message.content)
    .filter(
      (content): content is OpenAI.Responses.ResponseOutputText =>
        content.type === 'output_text',
    )
    .map((content) => content.text)
    .join('');
}

function extractRefusalText(response: Response): string {
  return response.output
    .filter(
      (item): item is OpenAI.Responses.ResponseOutputMessage =>
        item.type === 'message',
    )
    .flatMap((message) => message.content)
    .filter(
      (content): content is OpenAI.Responses.ResponseOutputRefusal =>
        content.type === 'refusal',
    )
    .map((content) => content.refusal)
    .join('');
}

function extractToolCalls(response: Response): ResponseFunctionToolCall[] {
  return response.output.filter(
    (item): item is ResponseFunctionToolCall => item.type === 'function_call',
  );
}

function buildRawAssistantItems(response: Response): ResponseInputItem[] {
  return response.output.filter((item) => {
    if (item.type === 'message') return true;
    if (item.type === 'function_call') return true;
    if (item.type === 'reasoning') return true;
    return false;
  }) as ResponseInputItem[];
}

function buildResponseErrorMessage(response: Response): string | null {
  if (response.error) {
    return `${response.error.code}: ${response.error.message}`;
  }
  if (response.incomplete_details?.reason) {
    return `response incomplete: ${response.incomplete_details.reason}`;
  }
  return null;
}

export class OpenAIResponsesAdapter
  implements LoopAdapter<ResponseInputItem, ResponseFunctionToolCall>
{
  readonly providerName = 'openai-response';
  private readonly trimmer: ContextTrimmer<ResponseInputItem>;

  constructor(
    private readonly client: OpenAI,
    options: { protectedToolNames?: Set<string> } = {},
  ) {
    this.trimmer = new ContextTrimmer<ResponseInputItem>(
      responsesMessageFormat,
      {
        protectedToolNames: options.protectedToolNames,
      },
    );
  }

  async createCompletion(
    messages: ResponseInputItem[],
    options: CompletionOptions,
  ): Promise<CompletionResult<ResponseFunctionToolCall>> {
    const response = await this.client.responses.create({
      model: options.model,
      instructions: buildInstructions(options.systemPrompt),
      input: messages,
      tools: convertToolDefinitions(options.tools ?? []),
      tool_choice:
        options.toolChoice === 'required' ? 'required' : undefined,
      temperature: options.temperature,
      max_output_tokens: resolveCompletionMaxOutputTokens({
        model: options.model,
        configured: options.maxOutputTokens,
      }),
      parallel_tool_calls: true,
      truncation: 'disabled',
    }, {
      signal: options.signal,
    });

    const responseError = buildResponseErrorMessage(response);
    if (response.status === 'failed' || response.status === 'incomplete') {
      throw new Error(`OpenAI Responses API 返回未完成状态: ${responseError ?? response.status}`);
    }

    const toolCalls = extractToolCalls(response);
    const textContent = extractOutputText(response) || extractRefusalText(response);

    return {
      toolCalls,
      textContent,
      finishReason: response.status ?? null,
      usage: response.usage
        ? {
            promptTokens: response.usage.input_tokens ?? 0,
            completionTokens: response.usage.output_tokens ?? 0,
          }
        : null,
      rawAssistantMessage: buildRawAssistantItems(response),
    };
  }

  buildToolResultMessages(
    results: Array<{ toolCall: ResponseFunctionToolCall; result: ToolResult }>,
  ): ResponseInputItem[] {
    return results.map(({ toolCall, result }) => ({
      type: 'function_call_output',
      call_id: toolCall.call_id,
      output: result.modelOutput ?? result.output,
    }));
  }

  buildUserMessage(content: string): ResponseInputItem {
    return {
      type: 'message',
      role: 'user',
      content: [buildInputText(content)],
    };
  }

  isStopDueToLength(
    result: CompletionResult<ResponseFunctionToolCall>,
  ): boolean {
    return result.finishReason === 'incomplete';
  }

  isApiError(error: unknown): boolean {
    return error instanceof OpenAI.APIError;
  }

  getApiErrorStatus(error: unknown): number | undefined {
    return error instanceof OpenAI.APIError ? error.status : undefined;
  }

  getApiErrorMessage(error: unknown): string {
    return error instanceof OpenAI.APIError
      ? error.message
      : String(error);
  }

  trimContextIfNeeded(
    messages: ResponseInputItem[],
    model: string,
    options: { aggressive?: boolean; contextWindowTokens?: number } = {},
  ): boolean {
    return this.trimmer.trimIfNeeded(messages, model, options);
  }

  getToolName(toolCall: ResponseFunctionToolCall): string {
    return toolCall.name;
  }

  getToolArgs(toolCall: ResponseFunctionToolCall): Record<string, unknown> {
    if (!toolCall.arguments) return {};
    try {
      return JSON.parse(toolCall.arguments) as Record<string, unknown>;
    } catch {
      throw new Error(`无效的参数 JSON: ${toolCall.arguments}`);
    }
  }
}

type ResponseMessageLike = ResponseInputItem & {
  role?: string;
  content?: unknown;
};

function isMessageLike(item: ResponseInputItem): item is ResponseMessageLike {
  return (
    item.type === 'message' ||
    ('role' in item && 'content' in item)
  );
}

function getMessageTextSegments(item: ResponseInputItem): TruncatableSegment[] {
  if (!isMessageLike(item)) return [];
  const segments: TruncatableSegment[] = [];
  if (typeof item.content === 'string') {
    segments.push({
      getText: () => item.content as string,
      setText: (text) => {
        item.content = text;
      },
    });
    return segments;
  }
  if (!Array.isArray(item.content)) return [];
  for (const content of item.content) {
    if (
      (content.type === 'input_text' || content.type === 'output_text') &&
      typeof content.text === 'string'
    ) {
      segments.push({
        getText: () => content.text,
        setText: (text) => {
          content.text = text;
        },
      });
    }
  }
  return segments;
}

const responsesMessageFormat: MessageFormat<ResponseInputItem> = {
  estimateTokens(messages) {
    let total = 0;
    for (const item of messages) {
      total += 4;
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const content of item.content) {
          total += roughTokenCount(JSON.stringify(content));
        }
      } else {
        total += roughTokenCount(JSON.stringify(item));
      }
    }
    return total;
  },

  role(item) {
    if ('role' in item && typeof item.role === 'string') return item.role;
    if (item.type === 'function_call') return 'assistant';
    if (item.type === 'function_call_output') return 'tool';
    return typeof item.type === 'string' ? item.type : 'item';
  },

  isRealUserMessage(item) {
    return isMessageLike(item) && item.role === 'user';
  },

  toolCallEntries(item) {
    if (item.type !== 'function_call') return [];
    return [{ id: item.call_id, name: item.name }];
  },

  toolResultIds(item) {
    if (item.type !== 'function_call_output') return [];
    return [item.call_id];
  },

  toolResultSegments(item): TruncatableSegment[] {
    if (item.type !== 'function_call_output') return [];
    return [
      {
        getText: () => item.output,
        setText: (text) => {
          item.output = text;
        },
        toolId: item.call_id,
      },
    ];
  },

  assistantTextSegments(item): TruncatableSegment[] {
    if (!isMessageLike(item) || item.role !== 'assistant') return [];
    return getMessageTextSegments(item);
  },

  isFullyTruncatedToolResult(item, marker) {
    return item.type === 'function_call_output' && item.output === marker;
  },
};
