import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';

import { appendTranscriptEvent } from '../transcript-store.js';
import { traceEvent } from '../trace.js';
import type { RequestScope } from '../request-scope.js';
import type { AiChatStreamEvent, TokenUsage } from '../types.js';

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

function isAssistantMessage(
  value: unknown,
): value is {
  role: 'assistant';
  content: unknown;
  usage?: {
    input?: number;
    output?: number;
    totalTokens?: number;
  };
  stopReason?: string;
  errorMessage?: string;
} {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    (value as { role?: unknown }).role === 'assistant'
  );
}

function mergeAssistantUsage(
  usage: TokenUsage,
  message: { usage?: { input?: number; output?: number; totalTokens?: number } },
): void {
  if (!message.usage) return;
  const promptTokens = message.usage.input ?? 0;
  const completionTokens = message.usage.output ?? 0;
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
  setLastAssistantText(text: string): void;
  publishStreamEvent?: (event: AiChatStreamEvent) => void;
}): (event: AgentSessionEvent) => void {
  let lastAssistantSnapshot = '';

  function publish(event: AiChatStreamEvent): void {
    args.publishStreamEvent?.(event);
  }

  return (event) => {
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
        publish({
          type: 'turn_start',
          turnIndex: readTurnIndex(event),
        });
        break;
      case 'message_update':
        if (isAssistantMessage(event.message)) {
          const snapshot = textFromContent(event.message.content);
          const delta = snapshot.startsWith(lastAssistantSnapshot)
            ? snapshot.slice(lastAssistantSnapshot.length)
            : snapshot;
          lastAssistantSnapshot = snapshot;
          if (delta) {
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
        break;
      case 'tool_execution_update':
        publish({
          type: 'tool_update',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          partialResult: event.partialResult,
        });
        break;
      case 'tool_execution_end':
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

export function extractAssistantTextFromMessages(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isAssistantMessage(message)) continue;
    const text = textFromContent(message.content).trim();
    if (text) return text;
  }
  return null;
}
