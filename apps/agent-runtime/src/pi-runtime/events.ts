import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import {
  readModelFailure,
  type ModelFailure,
} from '@fateclaw/contracts/model-settings';

import { appendTranscriptEvent } from '../transcript-store.js';
import { traceEvent } from '../trace.js';
import { markRequestActivity, type RequestScope } from '../request-scope.js';
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
  const cacheIndex = parts.indexOf('cache-v1');
  if (cacheIndex >= 0) {
    return parts.slice(cacheIndex + 3).join('/') || undefined;
  }
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

type ToolResultPreview = NonNullable<
  AiChatProgressOutboxMessage['metadata']
>['tool_result'];

// 归一化限长参数：避免工具结果把 JSONB 撑大、拖慢消息加载。
const MAX_RESULT_ITEMS = 8;
const MAX_TITLE_LEN = 200;
const MAX_TEXT_LEN = 2000;
const MAX_THINKING_LEN = 64_000;

/** 把超长文本截断并标记。 */
function truncateText(
  value: string,
  max: number,
): { text: string; truncated: boolean } {
  if (value.length <= max) return { text: value, truncated: false };
  return { text: `${value.slice(0, max)}…`, truncated: true };
}

/** 从工具入参里提取查询/搜索词，用作富卡片标题。 */
function readToolQuery(args: unknown): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return undefined;
  }
  const record = args as Record<string, unknown>;
  for (const key of [
    'query',
    'q',
    'search',
    'keyword',
    'question',
    'text',
    'prompt',
  ]) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim().slice(0, MAX_TITLE_LEN);
    }
  }
  return undefined;
}

/** 从链接推导展示域名（去掉 www. 前缀）。 */
function deriveDomain(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const host = new URL(url).hostname;
    return host.replace(/^www\./, '') || undefined;
  } catch {
    return undefined;
  }
}

/** 解包 pi-runtime 工具结果的 { content:[{type:'text',text}], details } 包装。 */
function unwrapToolOutput(result: unknown): {
  details?: Record<string, unknown>;
  text?: string;
} {
  if (typeof result === 'string') return { text: result };
  if (!result || typeof result !== 'object' || Array.isArray(result)) return {};
  const record = result as Record<string, unknown>;
  let text: string | undefined;
  if (Array.isArray(record.content)) {
    text = record.content
      .map((item) =>
        item &&
        typeof item === 'object' &&
        (item as { type?: unknown }).type === 'text' &&
        typeof (item as { text?: unknown }).text === 'string'
          ? (item as { text: string }).text
          : '',
      )
      .join('');
  }
  const details =
    record.details &&
    typeof record.details === 'object' &&
    !Array.isArray(record.details)
      ? (record.details as Record<string, unknown>)
      : undefined;
  return { details, text };
}

/** 在 details 里找第一个非空的结果数组（检索命中 / 反推候选 / 盘面列表等）。 */
function findFirstResultArray(
  details: Record<string, unknown>,
): unknown[] | null {
  for (const key of [
    'matches',
    'boards',
    'results',
    'items',
    'sections',
    'entries',
    'hits',
  ]) {
    const value = details[key];
    if (Array.isArray(value) && value.length > 0) return value;
  }
  return null;
}

/** 把结果数组归一化为时间线富卡片的 items（标题 + 右侧来源标签）。 */
function mapResultItems(
  entries: unknown[],
): Array<{ title: string; url?: string; domain?: string }> {
  const items: Array<{ title: string; url?: string; domain?: string }> = [];
  for (const entry of entries) {
    if (items.length >= MAX_RESULT_ITEMS) break;
    if (typeof entry === 'string') {
      if (entry.trim()) {
        items.push({ title: truncateText(entry.trim(), MAX_TITLE_LEN).text });
      }
      continue;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const titleRaw = [
      record.relativePath,
      record.path,
      record.title,
      record.name,
      record.sectionTitle,
      record.skillName,
      record.heading,
      record.solar,
      record.label,
    ].find((value) => typeof value === 'string' && value.trim()) as
      | string
      | undefined;
    if (!titleRaw) continue;
    const line = typeof record.line === 'number' ? `:${record.line}` : '';
    const url = [record.url, record.link, record.href].find(
      (value) => typeof value === 'string' && value.trim(),
    ) as string | undefined;
    const domain =
      typeof record.skill === 'string' &&
      record.skill.trim() &&
      record.skill !== titleRaw
        ? record.skill.trim()
        : typeof record.domain === 'string' && record.domain.trim()
          ? record.domain.trim()
          : deriveDomain(url);
    items.push({
      title: truncateText(`${titleRaw.trim()}${line}`, MAX_TITLE_LEN).text,
      url: url?.trim(),
      domain,
    });
  }
  return items;
}

/**
 * 把工具结果归一化为受限大小的预览。
 *
 * pi-runtime 的 result 是 { content:[{type:'text',text}], details } 包装：先解包，
 * 用 details 里的结果数组/total 产出结构化 items，否则仅在输出是人类可读文本（非 JSON）
 * 时降级为截断文本——绝不把原始 JSON 包装塞进卡片。
 */
function normalizeToolResult(
  result: unknown,
  args: unknown,
): ToolResultPreview {
  const query = readToolQuery(args);
  if (result === undefined || result === null) {
    return query ? { query } : undefined;
  }

  const { details, text: contentText } = unwrapToolOutput(result);
  const output = (contentText ?? '').trim();

  const primaryArray = details ? findFirstResultArray(details) : null;
  let count: number | undefined;
  if (typeof details?.total === 'number' && Number.isFinite(details.total)) {
    count = details.total;
  } else if (primaryArray) {
    count = primaryArray.length;
  }

  const items = primaryArray ? mapResultItems(primaryArray) : [];
  if (items.length > 0) {
    return {
      query,
      count,
      items,
      truncated: (count ?? items.length) > items.length || undefined,
    };
  }

  // 没有结果列表：仅当输出是人类可读文本（非 JSON 包装）时作为预览。
  const looksLikeJson = output.startsWith('{') || output.startsWith('[');
  if (output && !looksLikeJson) {
    const { text, truncated } = truncateText(output, MAX_TEXT_LEN);
    return { query, count, text, truncated: truncated || undefined };
  }

  return query !== undefined || count !== undefined
    ? { query, count }
    : undefined;
}

function buildToolProgressMessage(args: {
  accountId: string;
  requestId?: string;
  toolCallId: string;
  toolName: string;
  toolArgs?: unknown;
  toolResult?: unknown;
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
  // running 阶段还没有结果，只带上查询词；completed/failed 时归一化结果做富卡片。
  const preview =
    args.status === 'running'
      ? ((): ToolResultPreview => {
          const query = readToolQuery(args.toolArgs);
          return query ? { query } : undefined;
        })()
      : normalizeToolResult(args.toolResult, args.toolArgs);

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
      query_text: preview?.query,
      tool_result: preview,
    },
  };
}

/**
 * 构造一条「思考」outbox 消息用于落库。
 *
 * @param timestamp 用回合开始时间，保证思考排在本回合工具调用之前（穿插顺序正确）。
 */
function buildThinkingProgressMessage(args: {
  accountId: string;
  requestId?: string;
  turnIndex?: number;
  text: string;
  timestamp?: string;
}): AiChatProgressOutboxMessage {
  const { text } = truncateText(args.text.trim(), MAX_THINKING_LEN);
  return {
    type: 'progress',
    accountId: args.accountId,
    requestId: args.requestId,
    text,
    timestamp: args.timestamp ?? new Date().toISOString(),
    metadata: {
      kind: 'thinking',
      stage: 'thinking',
      workflow: 'pi_runtime',
      turn_index: args.turnIndex,
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
