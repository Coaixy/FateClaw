import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';

import { appendTranscriptEvent } from '../transcript-store.js';
import { traceEvent } from '../trace.js';
import type { RequestScope } from '../request-scope.js';
import type { TokenUsage } from '../types.js';

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
}): (event: AgentSessionEvent) => void {
  return (event) => {
    switch (event.type) {
      case 'agent_start':
        traceEvent({ type: 'pi_agent_start' }, args.requestScope);
        break;
      case 'turn_start':
        traceEvent(
          { type: 'pi_turn_start', turnIndex: readTurnIndex(event) },
          args.requestScope,
        );
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
