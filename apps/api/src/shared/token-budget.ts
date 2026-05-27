import {
  getContextWindow,
  resolveContextWindow,
} from './model-context-window.js';
import { getDefaultMaxOutputTokens } from './output-token-policy.js';
export { getContextWindow } from './model-context-window.js';

/**
 * 动态 Token 预算调控。
 *
 * 根据模型上下文窗口大小，动态分配 prompt 各部分的 token 预算，
 * 确保为模型输出和工具循环预留足够空间，不影响当前对话质量。
 *
 * 分配优先级（从高到低）：
 * 1. 输出预留 — 保证模型有充足空间回复
 * 2. 工具循环预留 — 保证多轮工具调用不爆上下文
 * 3. agent 系统 prompt + 工具定义 — 固定开销
 * 4. 当前用户消息 — 不可压缩
 * 5. soul.md 长期记忆 — 有上限 cap
 * 6. 对话历史 — 弹性填充剩余空间
 */

// ---------------------------------------------------------------------------
// Token 估算
// ---------------------------------------------------------------------------

/**
 * 粗略估算文本的 token 数量。
 * CJK 字符约 1.5 字符/token，ASCII 约 4 字符/token。
 * 偏保守（宁可少放内容也不爆上下文）。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  let cjk = 0;
  let other = 0;

  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
      (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
      (code >= 0x3000 && code <= 0x303f) || // CJK Symbols & Punctuation
      (code >= 0xff00 && code <= 0xffef) || // Fullwidth Forms
      (code >= 0xf900 && code <= 0xfaff) // CJK Compatibility Ideographs
    ) {
      cjk++;
    } else {
      other++;
    }
  }

  // 偏保守：CJK 按 1.2 chars/token，ASCII 按 3.5 chars/token
  return Math.ceil(cjk / 1.2 + other / 3.5);
}

// ---------------------------------------------------------------------------
// 预算分配
// ---------------------------------------------------------------------------

/**
 * 预算设计原则：
 * - 按典型场景分配，不按极端情况。容器侧 Pi Runtime 会按模型窗口裁剪上下文。
 * - 聊天场景通常回复短、tool 调用少，但长上下文模型可以保留更大的输出空间。
 * - 大窗口模型下，大部分空间仍给 history + skill context，提升上下文连贯性。
 */

/** agent-runner 的 system prompt + tool definitions 预估开销。 */
const SYSTEM_PROMPT_RESERVE = 4000;

/** soul.md 的绝对 token 上限。 */
const SOUL_ABSOLUTE_CAP = 3000;

/** Skill 上下文（tool_context）的独立预算上限。能装 2-3 份 skill 原始数据。 */
const SKILL_CONTEXT_CAP = 8000;

/** 对话历史的绝对 token 上限。200k 模型下约 50k，能装 20+ 轮对话。 */
const HISTORY_ABSOLUTE_CAP = 50_000;

export interface TokenAllocation {
  /** 模型上下文窗口总大小 */
  contextWindow: number;
  /** 模型输出预留 */
  outputReserve: number;
  /** 工具循环预留 */
  toolLoopReserve: number;
  /** 系统 prompt 预估占用 */
  systemPromptReserve: number;
  /** 当前用户消息占用 */
  currentMessageTokens: number;
  /** soul.md 可用预算 */
  soulBudget: number;
  /** 对话历史可用预算 */
  historyBudget: number;
  /** Skill 上下文（tool_context）独立预算 */
  skillContextBudget: number;
  /** 可用于内容的总预算（soul + history + skillContext） */
  contentBudget: number;
}

/**
 * 计算各部分的 token 预算。
 *
 * 分配策略：
 *   1. 输出预留 — 来自请求级模型配置；未配置时按上下文窗口自动计算
 *   2. 工具循环预留 — 窗口的 10%（容器侧 Pi Runtime 会按模型窗口兜底）
 *   3. 固定开销 — system prompt + 当前消息
 *   4. 剩余空间按优先级分配：skill context → soul → history
 */
export function computeTokenBudget(
  model: string,
  currentMessage: string,
  options: {
    contextWindowTokens?: number | null;
    maxOutputTokens?: number;
  } = {},
): TokenAllocation {
  const contextWindow = resolveContextWindow({
    model,
    configured: options.contextWindowTokens,
  });
  const maxOutputTokens =
    options.maxOutputTokens ??
    getDefaultMaxOutputTokens(model, options.contextWindowTokens);
  const outputReserve = maxOutputTokens;

  // 工具循环预留：窗口的 10%。典型场景用 2-3 轮（~6k），
  // 极端场景容器侧 Pi Runtime 会按模型窗口裁剪兜底。
  const toolLoopReserve = Math.floor(contextWindow * 0.1);

  const currentMessageTokens = estimateTokens(currentMessage);

  // 可用于内容的总预算
  const contentBudget = Math.max(
    0,
    contextWindow -
      outputReserve -
      toolLoopReserve -
      SYSTEM_PROMPT_RESERVE -
      currentMessageTokens,
  );

  // 各部分按固定上限分配，有富余就留给 history
  const soulBudget = Math.min(SOUL_ABSOLUTE_CAP, contentBudget);
  const skillContextBudget = Math.min(
    SKILL_CONTEXT_CAP,
    Math.max(0, contentBudget - soulBudget),
  );
  const historyBudget = Math.min(
    Math.max(0, contentBudget - soulBudget - skillContextBudget),
    HISTORY_ABSOLUTE_CAP,
  );

  return {
    contextWindow,
    outputReserve,
    toolLoopReserve,
    systemPromptReserve: SYSTEM_PROMPT_RESERVE,
    currentMessageTokens,
    soulBudget,
    historyBudget,
    skillContextBudget,
    contentBudget,
  };
}

// ---------------------------------------------------------------------------
// 截断与填充
// ---------------------------------------------------------------------------

/**
 * 按 token 预算截断文本。从开头保留，超出部分截断并附加省略标记。
 */
export function truncateToTokenBudget(text: string, budget: number): string {
  if (budget <= 0) return '';
  if (estimateTokens(text) <= budget) return text;

  // 根据估算比例计算大致截断位置，然后微调
  const ratio = budget / estimateTokens(text);
  let cutPoint = Math.floor(text.length * ratio * 0.9); // 留 10% 余量

  // 向前微调到不超过预算（减去省略标记的开销）
  const marker = '\n...(已截断)';
  const markerTokens = estimateTokens(marker);

  while (
    cutPoint > 0 &&
    estimateTokens(text.slice(0, cutPoint)) > budget - markerTokens
  ) {
    cutPoint = Math.floor(cutPoint * 0.9);
  }

  return text.slice(0, cutPoint) + marker;
}

/**
 * 从最近消息向前填充，直到用完 token 预算。
 *
 * @param messages - 按时间 **倒序** 排列的消息（最新在前，与 DB 查询一致）
 * @param budget - 可用 token 预算
 * @returns 按时间 **正序** 排列的对话行
 */
export function fillHistoryWithBudget(
  messages: Array<{ is_from_me?: boolean | number; content: string }>,
  budget: number,
): string[] {
  if (budget <= 0) return [];

  const lines: string[] = [];
  let used = 0;

  // messages 已按时间倒序（最新在前），从最新往最旧填充
  for (const m of messages) {
    const prefix = m.is_from_me ? 'Assistant' : 'User';
    const line = `${prefix}: ${m.content}`;
    const cost = estimateTokens(line);

    if (used + cost > budget) break;

    lines.unshift(line); // 头部插入，恢复时间正序
    used += cost;
  }

  return lines;
}

/** 结构化历史消息（与 agent-runner HistoryMessage 对齐）。 */
export interface SkillContextEntry {
  skill: string;
  output: string;
  artifactType?: string;
  artifactTitle?: string;
  artifactData?: unknown;
}

export interface ActiveBoardContext extends SkillContextEntry {
  sourceMessageId: string;
}

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
  toolContext?: SkillContextEntry[];
}

function parseToolContext(
  raw: string | null | undefined,
): HistoryMessage['toolContext'] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const entries = parsed.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const entry = item as Record<string, unknown>;
      if (typeof entry.skill !== 'string' || typeof entry.output !== 'string') {
        return [];
      }
      return [
        {
          skill: entry.skill,
          output: entry.output,
          artifactType:
            typeof entry.artifactType === 'string'
              ? entry.artifactType
              : undefined,
          artifactTitle:
            typeof entry.artifactTitle === 'string'
              ? entry.artifactTitle
              : undefined,
          artifactData: entry.artifactData,
        },
      ];
    });
    return entries.length > 0 ? entries : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 结构化版本的历史填充：返回 HistoryMessage[] 而非 string[]。
 * 供 v2 IPC 协议使用，按 token 预算从最近向前填充。
 *
 * tool_context（skill 原始数据）使用独立预算，按从新到旧的顺序累积，
 * 直到 skill 预算用完。这样能保留最近几次 skill 结果（如排盘+解读），
 * 更早的 skill 数据自然淘汰。
 *
 * @param messages - 按时间 **倒序** 排列的消息（最新在前，与 DB 查询一致）
 * @param budget - 对话历史可用 token 预算
 * @param skillContextBudget - skill 上下文独立预算（默认 0 = 不注入）
 * @returns 按时间 **正序** 排列的 HistoryMessage
 */
export function fillHistoryStructured(
  messages: Array<{
    is_from_me?: boolean | number;
    content: string;
    timestamp?: string;
    tool_context?: string | null;
  }>,
  budget: number,
  skillContextBudget: number = 0,
): HistoryMessage[] {
  if (budget <= 0) return [];

  // 第一遍：从新到旧扫描，确定哪些 tool_context 在预算内可以注入
  const injectableSkillIdxs = new Set<number>();
  let skillUsed = 0;
  if (skillContextBudget > 0) {
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (!m.is_from_me || !m.tool_context) continue;
      const cost = estimateTokens(m.tool_context) + 20;
      if (skillUsed + cost > skillContextBudget) continue; // 超预算，跳过这条但继续看更早的（可能更小）
      injectableSkillIdxs.add(i);
      skillUsed += cost;
    }
  }

  // 第二遍：按 history 预算从新到旧填充
  const result: HistoryMessage[] = [];
  let used = 0;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const content = m.content;
    const toolContext = injectableSkillIdxs.has(i)
      ? parseToolContext(m.tool_context)
      : undefined;

    const cost = estimateTokens(content) + 10;
    if (used + cost > budget) break;

    result.unshift({
      role: m.is_from_me ? 'assistant' : 'user',
      content,
      timestamp: m.timestamp,
      toolContext,
    });
    used += cost;
  }

  return result;
}
