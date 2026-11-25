import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import {
  readModelFailure,
  type ModelFailure,
} from '@fateclaw/contracts/model-settings';

import { appendTranscriptEvent } from '#agent/transcript-store';
import { traceEvent } from '#agent/trace';
import { markRequestActivity, type RequestScope } from '#agent/request-scope';
import type {
  AiChatProgressOutboxMessage,
  AiChatStreamEvent,
  TokenUsage,
} from '#agent/types';
import {
  buildThinkingProgressMessage,
  buildToolProgressMessage,
} from './progress-messages.js';

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (
        item &&
        typeof item === 'object' &&
        (item as { type?: unknown }).type === 'text' &&
        typeof (item as { text?: unknown }).text === 'string'
      ) {
        return (item as { text: string }).text;
      }
      return '';
    })
    .join('');
}

function thinkingFromContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (
        item &&
        typeof item === 'object' &&
        (item as { type?: unknown }).type === 'thinking' &&
        typeof (item as { thinking?: unknown }).thinking === 'string'
      ) {
        return (item as { thinking: string }).thinking;
      }
      return '';
    })
    .join('');
}

function isAssistantMessage(value: unknown): value is {
  role: 'assistant';
  content: unknown;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
  };
  stopReason?: string;
  errorMessage?: string;
  modelFailure?: unknown;
} {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    (value as { role?: unknown }).role === 'assistant'
  );
}

function mergeAssistantUsage(
  usage: TokenUsage,
  message: {
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      totalTokens?: number;
    };
  },
): void {
  if (!message.usage) return;
  const cacheReadTokens = message.usage.cacheRead ?? 0;
  const cacheWriteTokens = message.usage.cacheWrite ?? 0;
  // 底层 provider 会把 prompt cache 单独拆成 cacheRead/cacheWrite。
  // FateClaw 当前只有输入/输出两档价格，缓存 token 按输入 token 口径计入，避免低估实际消耗。
  const promptTokens =
    (message.usage.input ?? 0) + cacheReadTokens + cacheWriteTokens;
  const completionTokens = message.usage.output ?? 0;
  if (cacheReadTokens)
    usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + cacheReadTokens;
  if (cacheWriteTokens)
    usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + cacheWriteTokens;
  usage.promptTokens += promptTokens;
  usage.completionTokens += completionTokens;
  usage.totalTokens +=
    message.usage.totalTokens ?? promptTokens + completionTokens;
}

function readTurnIndex(event: AgentSessionEvent): number | undefined {
  return typeof (event as { turnIndex?: unknown }).turnIndex === 'number'
    ? (event as unknown as { turnIndex: number }).turnIndex
    : undefined;
}

export function createPiEventCollector(args: {
  requestScope: RequestScope;
  usage: TokenUsage;
  modelStartedAtMs?: number;
  accountId: string;
  requestId?: string;
  setLastAssistantText(text: string): void;
  publishStreamEvent?: (event: AiChatStreamEvent) => void;
  pushOutboxProgress?: (message: AiChatProgressOutboxMessage) => void;
}): (event: AgentSessionEvent) => void {
  const startedAtMs = args.modelStartedAtMs ?? Date.now();
  const recordedContent = new Set<string>();
  const firstContent = (stage: 'first_content' | 'first_answer') => {
    if (recordedContent.has(stage)) return;
    recordedContent.add(stage);
    traceEvent(
      { type: 'agent_timing', stage, durationMs: Date.now() - startedAtMs },
      args.requestScope,
    );
  };
  let lastAssistantSnapshot = '';
  let lastThinkingSnapshot = '';
  // 回合开始时间：思考在 turn_end 才发射，但要排在本回合工具之前，故落库时盖上此时间戳。
  let currentTurnStartedAt = new Date().toISOString();
  const toolArgsById = new Map<string, unknown>();

  function publish(event: AiChatStreamEvent): void {
    args.publishStreamEvent?.(event);
  }

  return (event) => {
    // message_update 的文本 delta 不写 trace，但同样证明 Provider 仍在流式推进；
    // 因此所有 Pi 事件都刷新活动时间，避免长思考或长回答被停滞 watchdog 误杀。
    markRequestActivity(args.requestScope);
    switch (event.type) {
      case 'agent_start':
        traceEvent({ type: 'pi_agent_start' }, args.requestScope);
        publish({ type: 'agent_start' });
        break;
      case 'turn_start':
        traceEvent(
          { type: 'pi_turn_start', turnIndex: readTurnIndex(event) },
          args.requestScope,
        );
        lastAssistantSnapshot = '';
        lastThinkingSnapshot = '';
        currentTurnStartedAt = new Date().toISOString();
        publish({
          type: 'turn_start',
          turnIndex: readTurnIndex(event),
        });
        break;
      case 'message_update':
        if (isAssistantMessage(event.message)) {
          const thinkingSnapshot = thinkingFromContent(event.message.content);
          if (thinkingSnapshot) {
            const thinkingDelta = thinkingSnapshot.startsWith(
              lastThinkingSnapshot,
            )
              ? thinkingSnapshot.slice(lastThinkingSnapshot.length)
              : thinkingSnapshot;
            lastThinkingSnapshot = thinkingSnapshot;
            if (thinkingDelta) {
              firstContent('first_content');
              publish({
                type: 'thinking_delta',
                delta: thinkingDelta,
                snapshot: thinkingSnapshot,
                turnIndex: readTurnIndex(event),
              });
            }
          }

          const snapshot = textFromContent(event.message.content);
          const delta = snapshot.startsWith(lastAssistantSnapshot)
            ? snapshot.slice(lastAssistantSnapshot.length)
            : snapshot;
          lastAssistantSnapshot = snapshot;
          if (delta) {
            firstContent('first_content');
            firstContent('first_answer');
            publish({
              type: 'assistant_delta',
              delta,
              snapshot,
            });
          }
        }
        break;
      case 'turn_end':
        if (isAssistantMessage(event.message)) {
          mergeAssistantUsage(args.usage, event.message);
          traceEvent(
            {
              type: 'model_usage',
              cacheReadTokens: event.message.usage?.cacheRead ?? 0,
              cacheWriteTokens: event.message.usage?.cacheWrite ?? 0,
            },
            args.requestScope,
          );
          args.requestScope.partialUsage = { ...args.usage };
          const thinking = thinkingFromContent(event.message.content);
          if (thinking.trim() && thinking !== lastThinkingSnapshot) {
            publish({
              type: 'thinking_delta',
              delta: thinking.startsWith(lastThinkingSnapshot)
                ? thinking.slice(lastThinkingSnapshot.length)
                : thinking,
              snapshot: thinking,
              turnIndex: readTurnIndex(event),
            });
            lastThinkingSnapshot = thinking;
          }
          // 本回合思考完整后落库：盖上回合起始时间戳，使其排在本回合工具调用之前。
          if (thinking.trim()) {
            args.pushOutboxProgress?.(
              buildThinkingProgressMessage({
                accountId: args.accountId,
                requestId: args.requestId,
                turnIndex: readTurnIndex(event),
                text: thinking,
                timestamp: currentTurnStartedAt,
              }),
            );
          }
          const text = textFromContent(event.message.content);
          if (text.trim()) {
            appendTranscriptEvent(args.requestScope, {
              type: 'assistant',
              text,
            });
            args.setLastAssistantText(text);
          }
          traceEvent(
            {
              type: 'pi_turn_end',
              turnIndex: readTurnIndex(event),
              stopReason: event.message.stopReason,
              toolResultCount: event.toolResults.length,
              textLength: text.length,
            },
            args.requestScope,
          );
          if (text.trim()) {
            publish({
              type: 'assistant_message',
              text,
              turnIndex: readTurnIndex(event),
            });
          }
          publish({
            type: 'usage',
            usage: {
              promptTokens: args.usage.promptTokens,
              completionTokens: args.usage.completionTokens,
              totalTokens: args.usage.totalTokens,
            },
          });
        }
        break;
      case 'tool_execution_start':
        toolArgsById.set(event.toolCallId, event.args);
        traceEvent(
          {
            type: 'pi_tool_execution_start',
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
          },
          args.requestScope,
        );
        publish({
          type: 'tool_start',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });
        args.pushOutboxProgress?.(
          buildToolProgressMessage({
            accountId: args.accountId,
            requestId: args.requestId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            toolArgs: event.args,
            status: 'running',
          }),
        );
        break;
      case 'tool_execution_update':
        toolArgsById.set(event.toolCallId, event.args);
        publish({
          type: 'tool_update',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          partialResult: event.partialResult,
        });
        break;
      case 'tool_execution_end':
        {
          const toolArgs = toolArgsById.get(event.toolCallId);
          toolArgsById.delete(event.toolCallId);
          traceEvent(
            {
              type: 'pi_tool_execution_end',
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              isError: event.isError,
            },
            args.requestScope,
          );
          publish({
            type: 'tool_end',
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            result: event.result,
            isError: event.isError,
          });
          args.pushOutboxProgress?.(
            buildToolProgressMessage({
              accountId: args.accountId,
              requestId: args.requestId,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              toolArgs,
              toolResult: event.result,
              status: event.isError ? 'failed' : 'completed',
            }),
          );
        }
        break;
      case 'agent_end':
        traceEvent(
          {
            type: 'pi_agent_end',
            messageCount: event.messages.length,
            willRetry: event.willRetry,
          },
          args.requestScope,
        );
        publish({
          type: 'agent_end',
          messageCount: event.messages.length,
          willRetry: event.willRetry,
        });
        break;
      case 'auto_retry_start':
      case 'auto_retry_end':
      case 'compaction_start':
      case 'compaction_end':
        traceEvent(
          {
            type: `pi_${event.type}`,
            event,
          },
          args.requestScope,
        );
        break;
      default:
        break;
    }
  };
}

/**
 * 读取 Pi 会话最后一条 assistant 消息的正文与失败信息。
 *
 * Pi SDK 的 Provider 请求失败不会保证 `session.prompt()` 抛异常，而是可能返回一条
 * `stopReason: "error"`、正文为空、错误写在 `errorMessage` 的 assistant 消息。
 * 这里只读取最后一条 assistant，避免当前轮失败时误拿历史回复当成本轮结果。
 *
 * @param messages Pi session 当前保存的完整消息列表。
 * @returns 最后一条 assistant 的正文和错误；没有 assistant 时返回 null。
 */
export function extractLatestAssistantResult(messages: unknown[]): {
  text: string | null;
  error: string | null;
  modelFailure?: ModelFailure;
} | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isAssistantMessage(message)) continue;
    const text = textFromContent(message.content).trim();
    const errorMessage = message.errorMessage?.trim();
    const error =
      message.stopReason === 'error' ||
      (message.stopReason !== 'aborted' && Boolean(errorMessage))
        ? errorMessage || '模型服务返回错误，但没有提供错误详情'
        : null;
    const modelFailure = error
      ? readModelFailure(message.modelFailure)
      : undefined;
    return {
      text: text || null,
      error,
      ...(modelFailure ? { modelFailure } : {}),
    };
  }
  return null;
}
