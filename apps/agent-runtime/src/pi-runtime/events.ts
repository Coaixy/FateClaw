import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';

import { appendTranscriptEvent } from '../transcript-store.js';
import { traceEvent } from '../trace.js';
import type { RequestScope } from '../request-scope.js';
import type {
  AiChatProgressOutboxMessage,
  AiChatStreamEvent,
  TokenUsage,
} from '../types.js';

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

function isAssistantMessage(
  value: unknown,
): value is {
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

function getToolLabel(toolName: string): string {
  return toolName;
}

function readToolPath(args: unknown): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return undefined;
  }
  const path = (args as { path?: unknown }).path;
  return typeof path === 'string' && path.trim() ? path.trim() : undefined;
}

function normalizeSkillDir(value: string): string {
  const withoutOwner = value.startsWith('user-') ? value.slice(5) : value;
  return withoutOwner
    .replace(
      /-?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      '',
    )
    .replace(/-?[0-9a-f]{24,}$/i, '');
}

function sanitizeToolPath(rawPath?: string): string | undefined {
  if (!rawPath) return undefined;
  const normalized = rawPath.trim().replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  const skillFileIndex = (() => {
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      if (parts[index] === 'SKILL.md') return index;
    }
    return -1;
  })();
  if (skillFileIndex > 0) {
    return [
      normalizeSkillDir(parts[skillFileIndex - 1]),
      ...parts.slice(skillFileIndex),
    ].join('/');
  }
  const textSkillsIndex = parts.findIndex((part) => part === 'text-skills');
  if (textSkillsIndex >= 0 && textSkillsIndex + 2 < parts.length) {
    return [
      normalizeSkillDir(parts[textSkillsIndex + 2]),
      ...parts.slice(textSkillsIndex + 3),
    ].join('/');
  }
  if (parts.length > 2) {
    return parts.slice(-2).join('/');
  }
  return parts.join('/') || undefined;
}

function buildToolProgressMessage(args: {
  accountId: string;
  requestId?: string;
  toolCallId: string;
  toolName: string;
  toolArgs?: unknown;
  status: 'running' | 'completed' | 'failed';
}): AiChatProgressOutboxMessage {
  const label = getToolLabel(args.toolName);
  const path = sanitizeToolPath(readToolPath(args.toolArgs));
  const suffix =
    args.status === 'running'
      ? '中'
      : args.status === 'failed'
        ? '失败'
        : '完成';

  return {
    type: 'progress',
    accountId: args.accountId,
    requestId: args.requestId,
    text: path ? `${label}: ${path} ${suffix}` : `${label}${suffix}`,
    timestamp: new Date().toISOString(),
    metadata: {
      kind: 'tool_trace',
      stage: `tool_${args.status}`,
      workflow: 'pi_runtime',
      tool_call_id: args.toolCallId,
      tool_name: args.toolName,
      tool_label: label,
      tool_status: args.status,
      tool_path: path,
    },
  };
}

export function createPiEventCollector(args: {
  requestScope: RequestScope;
  usage: TokenUsage;
  accountId: string;
  requestId?: string;
  setLastAssistantText(text: string): void;
  publishStreamEvent?: (event: AiChatStreamEvent) => void;
  pushOutboxProgress?: (message: AiChatProgressOutboxMessage) => void;
}): (event: AgentSessionEvent) => void {
  let lastAssistantSnapshot = '';
  let lastThinkingSnapshot = '';
  const toolArgsById = new Map<string, unknown>();

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
        lastThinkingSnapshot = '';
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

export function extractAssistantTextFromMessages(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isAssistantMessage(message)) continue;
    const text = textFromContent(message.content).trim();
    if (text) return text;
  }
  return null;
}
