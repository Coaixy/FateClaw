/**
 * OpenAI 兼容 API 的 LoopAdapter 实现。
 */

import OpenAI from 'openai';

import type {
  LoopAdapter,
  CompletionOptions,
  CompletionResult,
} from './base-loop.js';
import { roughTokenCount } from './loop/token-calibration.js';
import { ContextTrimmer, type MessageFormat, type TruncatableSegment } from './context-trimmer.js';
import { toOpenAIStrictParameters } from './openai-strict-schema.js';
import { resolveCompletionMaxOutputTokens } from './output-token-policy.js';
import type { ToolResult } from './types.js';
import type { ChatMessage } from './types.js';

type OpenAIToolCall =
  OpenAI.Chat.Completions.ChatCompletionMessageToolCall;
type OpenAICompatibleAssistantMessage =
  OpenAI.Chat.Completions.ChatCompletionMessage & Record<string, unknown>;

function toStrictTools(
  tools: import('./types.js').ToolDefinition[],
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.function.name,
      description: t.function.description,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parameters: toOpenAIStrictParameters(t.function.parameters) as any,
      strict: true,
    },
  }));
}

export class OpenAIAdapter
  implements LoopAdapter<ChatMessage, OpenAIToolCall>
{
  readonly providerName = 'openai-compatible';

  /** 是否为 OpenAI 官方端点（支持 strict schema） */
  private readonly supportsStrictSchema: boolean;
  private readonly trimmer: ContextTrimmer<ChatMessage>;

  constructor(
    private readonly client: OpenAI,
    options: { protectedToolNames?: Set<string> } = {},
  ) {
    // 只有官方端点（baseURL 未自定义或指向 api.openai.com）才启用 strict schema
    const baseURL = client.baseURL;
    this.supportsStrictSchema =
      !baseURL || /api\.openai\.com/i.test(baseURL);
    this.trimmer = new ContextTrimmer<ChatMessage>(openaiMessageFormat, {
      protectedToolNames: options.protectedToolNames,
    });
  }

  // -----------------------------------------------------------------------
  // API 调用
  // -----------------------------------------------------------------------

  async createCompletion(
    messages: ChatMessage[],
    options: CompletionOptions,
  ): Promise<CompletionResult<OpenAIToolCall>> {
    const tools = options.tools ?? [];
    const plainTools = tools as OpenAI.Chat.Completions.ChatCompletionTool[];
    const maxTokens = resolveCompletionMaxOutputTokens({
      model: options.model,
      configured: options.maxOutputTokens,
    });
    // strict schema 只在官方 OpenAI 端点使用，兼容端点直接用原始格式
    const effectiveTools = this.supportsStrictSchema
      ? toStrictTools(tools)
      : plainTools;

    let response: OpenAI.Chat.Completions.ChatCompletion;
    try {
      response = await this.client.chat.completions.create({
        model: options.model,
        messages,
        tools: effectiveTools,
        tool_choice: options.toolChoice === 'required' ? 'required' : undefined,
        temperature: options.temperature,
        max_tokens: maxTokens,
      }, {
        signal: options.signal,
      });
    } catch (error) {
      if (!this.isApiError(error) || this.getApiErrorStatus(error) !== 400) {
        throw error;
      }

      const errMsg = this.getApiErrorMessage(error);

      // 端点不支持 strict schema → 降级为普通 tools 重试
      if (isStrictSchemaError(errMsg)) {
        response = await this.createWithFallback(messages, options, plainTools);
      } else if (
        options.toolChoice === 'required' &&
        isUnsupportedRequiredToolChoiceError(errMsg)
      ) {
        if (options.strictToolChoice) {
          throw new Error(
            `当前模型或兼容端点不支持 required tool_choice，无法保证工具协议正确性: ${errMsg}`,
          );
        }
        // 降级：去掉 required + 使用 plain tools
        response = await this.client.chat.completions.create({
          model: options.model,
          messages,
          tools: plainTools,
          temperature: options.temperature,
          max_tokens: maxTokens,
        }, {
          signal: options.signal,
        });
      } else {
        throw error;
      }
    }

    const choice = response.choices?.[0];
    if (!choice) {
      throw new Error(
        `OpenAI 兼容 API 未返回任何选项 (choices=${JSON.stringify(response.choices)})`,
      );
    }

    const rawAssistantMessage = buildRawAssistantMessage(choice.message);

    return {
      toolCalls: choice.message.tool_calls ?? [],
      textContent:
        typeof choice.message.content === 'string'
          ? choice.message.content
          : '',
      finishReason: choice.finish_reason,
      usage: response.usage
        ? {
            promptTokens: response.usage.prompt_tokens ?? 0,
            completionTokens: response.usage.completion_tokens ?? 0,
          }
        : null,
      rawAssistantMessage,
    };
  }

  /**
   * strict schema 不被支持时，使用 plain tools + 可选 tool_choice 降级重试。
   */
  private async createWithFallback(
    messages: ChatMessage[],
    options: CompletionOptions,
    plainTools: OpenAI.Chat.Completions.ChatCompletionTool[],
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    try {
      return await this.client.chat.completions.create({
        model: options.model,
        messages,
        tools: plainTools,
        tool_choice: options.toolChoice === 'required' ? 'required' : undefined,
        temperature: options.temperature,
        max_tokens: resolveCompletionMaxOutputTokens({
          model: options.model,
          configured: options.maxOutputTokens,
        }),
      }, {
        signal: options.signal,
      });
    } catch (retryError) {
      // plain tools + required 也失败 → 再降级去掉 required
      if (
        options.toolChoice === 'required' &&
        this.isApiError(retryError) &&
        this.getApiErrorStatus(retryError) === 400 &&
        isUnsupportedRequiredToolChoiceError(this.getApiErrorMessage(retryError))
      ) {
        if (options.strictToolChoice) {
          throw new Error(
            `当前模型或兼容端点不支持 required tool_choice，无法保证工具协议正确性: ${this.getApiErrorMessage(retryError)}`,
          );
        }
        return await this.client.chat.completions.create({
          model: options.model,
          messages,
          tools: plainTools,
          temperature: options.temperature,
          max_tokens: resolveCompletionMaxOutputTokens({
            model: options.model,
            configured: options.maxOutputTokens,
          }),
        }, {
          signal: options.signal,
        });
      }
      throw retryError;
    }
  }

  // -----------------------------------------------------------------------
  // 消息构造
  // -----------------------------------------------------------------------

  buildToolResultMessages(
    results: Array<{ toolCall: OpenAIToolCall; result: ToolResult }>,
  ): ChatMessage[] {
    return results.map(({ toolCall, result }) => ({
      role: 'tool' as const,
      tool_call_id: toolCall.id,
      content: result.modelOutput ?? result.output,
    }));
  }

  buildUserMessage(content: string): ChatMessage {
    return { role: 'user' as const, content };
  }

  // -----------------------------------------------------------------------
  // 状态判断
  // -----------------------------------------------------------------------

  isStopDueToLength(result: CompletionResult<OpenAIToolCall>): boolean {
    return result.finishReason === 'length';
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

  // -----------------------------------------------------------------------
  // 工具调用提取
  // -----------------------------------------------------------------------

  getToolName(toolCall: OpenAIToolCall): string {
    if (toolCall.type !== 'function') {
      throw new Error(`暂不支持的 tool call 类型: ${toolCall.type}`);
    }
    return toolCall.function.name;
  }

  getToolArgs(toolCall: OpenAIToolCall): Record<string, unknown> {
    const rawArgs = toolCall.function.arguments;
    if (!rawArgs) return {};
    try {
      return JSON.parse(rawArgs) as Record<string, unknown>;
    } catch {
      throw new Error(`无效的参数 JSON: ${rawArgs}`);
    }
  }

  // -----------------------------------------------------------------------
  // 上下文截断（委托给 ContextTrimmer）
  // -----------------------------------------------------------------------

  trimContextIfNeeded(
    messages: ChatMessage[],
    model: string,
    options: { aggressive?: boolean; contextWindowTokens?: number } = {},
  ): boolean {
    return this.trimmer.trimIfNeeded(messages, model, options);
  }
}

function buildRawAssistantMessage(
  message: OpenAI.Chat.Completions.ChatCompletionMessage,
): OpenAICompatibleAssistantMessage {
  const rawMessage = message as OpenAICompatibleAssistantMessage;
  return {
    ...rawMessage,
    role: 'assistant',
    content: message.content ?? null,
    tool_calls: message.tool_calls,
  };
}

function isStrictSchemaError(message: string): boolean {
  return /strict|additionalProperties|additional_properties/i.test(message) &&
    /invalid|unsupported|not support|unknown|unrecognized|unexpected|schema/i.test(message);
}

function isUnsupportedRequiredToolChoiceError(message: string): boolean {
  return /tool[_\s-]?choice|required|any/i.test(message) &&
    /invalid|unsupported|not support|unknown|unrecognized|unexpected|allowed/i.test(message);
}

// ---------------------------------------------------------------------------
// OpenAI 消息格式适配（ContextTrimmer 使用）
// ---------------------------------------------------------------------------

const openaiMessageFormat: MessageFormat<ChatMessage> = {
  estimateTokens(messages) {
    let total = 0;
    for (const msg of messages) {
      total += 4; // 消息帧开销
      if ('content' in msg && typeof msg.content === 'string') {
        total += roughTokenCount(msg.content);
      }
      if ('tool_calls' in msg && msg.tool_calls) {
        total += roughTokenCount(JSON.stringify(msg.tool_calls));
      }
    }
    return total;
  },

  role(msg) {
    return msg.role;
  },

  isRealUserMessage(msg) {
    // OpenAI 的 tool result 是独立的 role='tool' 消息，不会混在 user 消息里
    return msg.role === 'user';
  },

  toolCallEntries(msg) {
    if (
      msg.role !== 'assistant' ||
      !('tool_calls' in msg) ||
      !Array.isArray(msg.tool_calls)
    ) {
      return [];
    }
    return msg.tool_calls.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
    }));
  },

  toolResultIds(msg) {
    if (msg.role !== 'tool' || !('tool_call_id' in msg)) return [];
    return [msg.tool_call_id];
  },

  toolResultSegments(msg): TruncatableSegment[] {
    if (
      msg.role !== 'tool' ||
      !('content' in msg) ||
      typeof msg.content !== 'string'
    ) {
      return [];
    }
    // 闭包绑定到底层消息的 content 字段
    const m = msg as unknown as Record<string, unknown>;
    return [
      {
        getText: () => m.content as string,
        setText: (text: string) => {
          m.content = text;
        },
        toolId: 'tool_call_id' in msg ? (msg.tool_call_id as string) : undefined,
      },
    ];
  },

  assistantTextSegments(msg): TruncatableSegment[] {
    if (msg.role !== 'assistant' || typeof msg.content !== 'string') return [];
    const m = msg as unknown as Record<string, unknown>;
    return [
      {
        getText: () => m.content as string,
        setText: (text: string) => {
          m.content = text;
        },
      },
    ];
  },

  isFullyTruncatedToolResult(msg, marker) {
    const m = msg as unknown as Record<string, unknown>;
    return m.role === 'tool' && m.content === marker;
  },
};
