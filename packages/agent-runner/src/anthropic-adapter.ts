/**
 * Anthropic Messages API 的 LoopAdapter 实现。
 */

import Anthropic from '@anthropic-ai/sdk';

import type {
  LoopAdapter,
  CompletionOptions,
  CompletionResult,
} from './base-loop.js';
import { roughTokenCount } from './loop/token-calibration.js';
import { ContextTrimmer, type MessageFormat, type TruncatableSegment } from './context-trimmer.js';
import { resolveCompletionMaxOutputTokens } from './output-token-policy.js';
import type { SystemPromptParts } from './prompt/index.js';
import type { ToolDefinition, ToolResult } from './types.js';

type AnthropicMessage = Anthropic.Messages.MessageParam;
type AnthropicToolUse = Anthropic.Messages.ToolUseBlock;

// ---------------------------------------------------------------------------
// Tool 格式转换：OpenAI ToolDefinition → Anthropic Tool
// ---------------------------------------------------------------------------

function convertToolDefinitions(
  tools: ToolDefinition[],
): Anthropic.Messages.Tool[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema:
      t.function.parameters as Anthropic.Messages.Tool.InputSchema,
  }));
}

// ---------------------------------------------------------------------------
// System prompt → Anthropic content blocks（支持 prompt caching）
// ---------------------------------------------------------------------------

function buildSystemBlocks(
  parts?: SystemPromptParts,
): Anthropic.Messages.TextBlockParam[] | undefined {
  if (!parts) return undefined;

  const blocks: Anthropic.Messages.TextBlockParam[] = [
    {
      type: 'text',
      text: parts.cached,
      cache_control: { type: 'ephemeral' },
    },
  ];

  if (parts.uncached) {
    blocks.push({ type: 'text', text: parts.uncached });
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class AnthropicAdapter
  implements LoopAdapter<AnthropicMessage, AnthropicToolUse>
{
  readonly providerName = 'anthropic';
  private readonly trimmer: ContextTrimmer<AnthropicMessage>;

  constructor(
    private readonly client: Anthropic,
    options: { protectedToolNames?: Set<string> } = {},
  ) {
    this.trimmer = new ContextTrimmer<AnthropicMessage>(
      anthropicMessageFormat,
      {
        protectedToolNames: options.protectedToolNames,
      },
    );
  }

  // -----------------------------------------------------------------------
  // API 调用
  // -----------------------------------------------------------------------

  async createCompletion(
    messages: AnthropicMessage[],
    options: CompletionOptions,
  ): Promise<CompletionResult<AnthropicToolUse>> {
    const response = await this.client.messages.create({
      model: options.model,
      max_tokens: resolveCompletionMaxOutputTokens({
        model: options.model,
        configured: options.maxOutputTokens,
      }),
      system: buildSystemBlocks(options.systemPrompt),
      messages,
      tools: convertToolDefinitions(options.tools ?? []),
      tool_choice:
        options.toolChoice === 'required' ? { type: 'any' } : undefined,
      temperature: options.temperature,
    }, {
      signal: options.signal,
    });

    return this.mapResponse(response);
  }

  // -----------------------------------------------------------------------
  // 消息构造
  // -----------------------------------------------------------------------

  buildToolResultMessages(
    results: Array<{ toolCall: AnthropicToolUse; result: ToolResult }>,
  ): AnthropicMessage[] {
    // Anthropic 要求 tool_result 作为一条 user 消息的 content blocks
    const toolResultBlocks: Anthropic.Messages.ToolResultBlockParam[] =
      results.map(({ toolCall, result }) => ({
        type: 'tool_result' as const,
        tool_use_id: toolCall.id,
        content: result.modelOutput ?? result.output,
        is_error: result.isError ?? false,
      }));

    return [{ role: 'user', content: toolResultBlocks }];
  }

  buildUserMessage(content: string): AnthropicMessage {
    return { role: 'user', content };
  }

  // -----------------------------------------------------------------------
  // 状态判断
  // -----------------------------------------------------------------------

  isStopDueToLength(
    result: CompletionResult<AnthropicToolUse>,
  ): boolean {
    return result.finishReason === 'max_tokens';
  }

  isApiError(error: unknown): boolean {
    return error instanceof Anthropic.APIError;
  }

  getApiErrorStatus(error: unknown): number | undefined {
    return error instanceof Anthropic.APIError
      ? error.status
      : undefined;
  }

  getApiErrorMessage(error: unknown): string {
    return error instanceof Anthropic.APIError
      ? error.message
      : String(error);
  }

  // -----------------------------------------------------------------------
  // 工具调用提取
  // -----------------------------------------------------------------------

  getToolName(toolCall: AnthropicToolUse): string {
    return toolCall.name;
  }

  getToolArgs(toolCall: AnthropicToolUse): Record<string, unknown> {
    return (toolCall.input as Record<string, unknown>) ?? {};
  }

  // -----------------------------------------------------------------------
  // 上下文截断（委托给 ContextTrimmer）
  // -----------------------------------------------------------------------

  trimContextIfNeeded(
    messages: AnthropicMessage[],
    model: string,
    options: { aggressive?: boolean; contextWindowTokens?: number } = {},
  ): boolean {
    return this.trimmer.trimIfNeeded(messages, model, options);
  }

  // -----------------------------------------------------------------------
  // 内部辅助
  // -----------------------------------------------------------------------

  private mapResponse(
    response: Anthropic.Messages.Message,
  ): CompletionResult<AnthropicToolUse> {
    const toolUseBlocks = response.content.filter(
      (b): b is AnthropicToolUse => b.type === 'tool_use',
    );

    const textContent = response.content
      .filter(
        (b): b is Anthropic.Messages.TextBlock => b.type === 'text',
      )
      .map((b) => b.text)
      .join('');

    return {
      toolCalls: toolUseBlocks,
      textContent,
      finishReason: response.stop_reason,
      usage: response.usage
        ? {
            promptTokens: response.usage.input_tokens ?? 0,
            completionTokens: response.usage.output_tokens ?? 0,
          }
        : null,
      rawAssistantMessage: {
        role: 'assistant' as const,
        content: response.content,
      },
    };
  }

}

// ---------------------------------------------------------------------------
// Anthropic 消息格式适配（ContextTrimmer 使用）
// ---------------------------------------------------------------------------

/** Anthropic 的 user 消息 content block 类型（用于类型安全的字段访问）。 */
type AnyContentBlock = { type: string; [key: string]: unknown };

const anthropicMessageFormat: MessageFormat<AnthropicMessage> = {
  estimateTokens(messages) {
    let total = 0;
    for (const msg of messages) {
      total += 4;
      if (typeof msg.content === 'string') {
        total += roughTokenCount(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if ('text' in block && typeof block.text === 'string') {
            total += roughTokenCount(block.text);
          } else if (
            'content' in block &&
            typeof block.content === 'string'
          ) {
            total += roughTokenCount(block.content);
          } else {
            total += roughTokenCount(JSON.stringify(block));
          }
        }
      }
    }
    return total;
  },

  role(msg) {
    return msg.role;
  },

  isRealUserMessage(msg) {
    if (typeof msg.content === 'string') return true;
    if (!Array.isArray(msg.content)) return false;
    // 如果所有 block 都是 tool_result，这不是用户主动发的消息
    return msg.content.some((b) => b.type !== 'tool_result');
  },

  toolCallEntries(msg) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) return [];
    return msg.content
      .filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
      )
      .map((b) => ({ id: b.id, name: b.name }));
  },

  toolResultIds(msg) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return [];
    return msg.content
      .filter((b): b is Anthropic.Messages.ToolResultBlockParam =>
        b.type === 'tool_result',
      )
      .map((b) => b.tool_use_id);
  },

  toolResultSegments(msg): TruncatableSegment[] {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return [];
    const segs: TruncatableSegment[] = [];
    for (const block of msg.content) {
      if (
        block.type === 'tool_result' &&
        typeof block.content === 'string'
      ) {
        const b = block as unknown as AnyContentBlock;
        segs.push({
          getText: () => b.content as string,
          setText: (text: string) => { b.content = text; },
          toolId: b.tool_use_id as string,
        });
      }
    }
    return segs;
  },

  assistantTextSegments(msg): TruncatableSegment[] {
    if (msg.role !== 'assistant') return [];
    // assistant content 可以是 string 或 ContentBlock[]
    if (typeof msg.content === 'string') {
      const m = msg as { content: string };
      return [{
        getText: () => m.content,
        setText: (text: string) => { (m as { content: string }).content = text; },
      }];
    }
    if (!Array.isArray(msg.content)) return [];
    const segs: TruncatableSegment[] = [];
    for (const block of msg.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        const b = block as unknown as AnyContentBlock;
        segs.push({
          getText: () => b.text as string,
          setText: (text: string) => { b.text = text; },
        });
      }
    }
    return segs;
  },

  isFullyTruncatedToolResult(msg, marker) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return false;
    if (msg.content.length === 0) return false;
    const onlyToolResults = msg.content.every((b) => b.type === 'tool_result');
    if (!onlyToolResults) return false;
    return msg.content.every(
      (b) =>
        b.type !== 'tool_result' ||
        (typeof b.content === 'string' && b.content === marker),
    );
  },
};
