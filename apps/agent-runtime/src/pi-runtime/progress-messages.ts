import type { AiChatProgressOutboxMessage } from '#agent/types';

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
      string | undefined;
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

export function buildToolProgressMessage(args: {
  accountId: string;
  requestId?: string;
  toolCallId: string;
  toolName: string;
  toolArgs?: unknown;
  toolResult?: unknown;
  status: 'running' | 'completed' | 'failed';
}): AiChatProgressOutboxMessage {
  const label = args.toolName;
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
export function buildThinkingProgressMessage(args: {
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
