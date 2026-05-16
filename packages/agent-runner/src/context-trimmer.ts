/**
 * 统一上下文截断策略。
 *
 * 将截断的"做什么"（4 阶段优先级、保护窗口、skill 结果保护）
 * 与"消息长什么样"（OpenAI / Anthropic 格式差异）分离。
 *
 * adapter 实现 MessageFormat 描述自己的消息结构，
 * ContextTrimmer 负责统一的截断决策。
 */

import {
  getContextWindowForModel,
  roughTokenCount,
} from './loop/token-calibration.js';

// ---------------------------------------------------------------------------
// 消息格式抽象
// ---------------------------------------------------------------------------

/** 可截断的内容片段 — 通过闭包绑定到底层消息的具体字段。 */
export interface TruncatableSegment {
  getText(): string;
  setText(text: string): void;
  /** tool_call_id (OpenAI) 或 tool_use_id (Anthropic)，仅 tool result 片段有值。 */
  toolId?: string;
}

/**
 * 消息格式接口。
 * 每个 provider adapter 实现一次，描述其消息结构中如何读取/修改内容。
 */
export interface MessageFormat<TMsg> {
  /** 估算整个 messages 数组的 token 数。 */
  estimateTokens(messages: TMsg[]): number;
  /** 消息角色。 */
  role(msg: TMsg): string;
  /** 是否为用户主动发送的消息（排除纯 tool result 容器）。 */
  isRealUserMessage(msg: TMsg): boolean;
  /** 从 assistant 消息中提取工具调用条目。非 assistant 返回空数组。 */
  toolCallEntries(msg: TMsg): Array<{ id: string; name: string }>;
  /** 从消息中提取 tool result 的 ID 列表。 */
  toolResultIds(msg: TMsg): string[];
  /** 获取消息中可截断的 tool result 片段。 */
  toolResultSegments(msg: TMsg): TruncatableSegment[];
  /** 获取消息中可截断的 assistant 文本片段。 */
  assistantTextSegments(msg: TMsg): TruncatableSegment[];
  /** 消息是否为已全部截断的纯 tool result 容器（可安全移除）。 */
  isFullyTruncatedToolResult(msg: TMsg, marker: string): boolean;
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export interface TrimConfig {
  /** 保护窗口大小：最近 N 条真实 user 消息。默认 3。 */
  protectedUserRounds?: number;
  /** 需要保护结果的工具名称。默认 ['run_skill_script']。 */
  protectedToolNames?: Set<string>;
}

const DEFAULT_PROTECTED_USER_ROUNDS = 3;
const DEFAULT_PROTECTED_TOOL_NAMES = new Set(['run_skill_script']);

/** 截断标记（被截断的内容替换为此文本）。 */
export const TRUNCATION_MARKER = '[内容已截断]';

// ---------------------------------------------------------------------------
// ContextTrimmer
// ---------------------------------------------------------------------------

/**
 * 上下文截断器。
 *
 * 截断优先级（从先砍到最后砍）：
 *   Phase 1 — 保护窗口外的普通 tool result
 *   Phase 2 — 保护窗口外的 assistant 文本
 *   Phase 3 — 较早的 skill 结果（保留最近一次）
 *   Phase 4 — 清理已全部截断的空壳消息
 *
 * 永不截断：保护窗口内所有消息 + user 原始消息文本
 */
export class ContextTrimmer<TMsg> {
  private readonly protectedUserRounds: number;
  private readonly protectedToolNames: Set<string>;

  constructor(
    private readonly fmt: MessageFormat<TMsg>,
    config: TrimConfig = {},
  ) {
    this.protectedUserRounds =
      config.protectedUserRounds ?? DEFAULT_PROTECTED_USER_ROUNDS;
    this.protectedToolNames =
      config.protectedToolNames ?? DEFAULT_PROTECTED_TOOL_NAMES;
  }

  /** 按优先级截断上下文。返回 true 表示有内容被截断。 */
  trimIfNeeded(
    messages: TMsg[],
    model: string,
    options: { aggressive?: boolean; contextWindowTokens?: number } = {},
  ): boolean {
    const contextWindow =
      options.contextWindowTokens ?? getContextWindowForModel(model);
    const limit = Math.floor(contextWindow * 0.80);
    let tokens = this.fmt.estimateTokens(messages);
    if (tokens <= limit) return false;

    let trimmed = false;
    const markerCost = roughTokenCount(TRUNCATION_MARKER);
    const protectedIdxs = this.buildProtectedIndexes(
      messages,
      options.aggressive ?? false,
    );
    const skillIds = this.collectSkillResultIds(messages);

    // Phase 1: 截断保护窗口外的普通 tool result（跳过 skill 结果）
    for (let i = 1; i < messages.length && tokens > limit; i++) {
      if (protectedIdxs.has(i)) continue;
      for (const seg of this.fmt.toolResultSegments(messages[i])) {
        if (tokens <= limit) break;
        if (seg.toolId && skillIds.has(seg.toolId)) continue;
        if (seg.getText().length > 100) {
          tokens -= roughTokenCount(seg.getText()) - markerCost;
          seg.setText(TRUNCATION_MARKER);
          trimmed = true;
        }
      }
    }

    // Phase 2: 截断保护窗口外的 assistant 文本
    for (let i = 1; i < messages.length && tokens > limit; i++) {
      if (protectedIdxs.has(i)) continue;
      for (const seg of this.fmt.assistantTextSegments(messages[i])) {
        if (tokens <= limit) break;
        if (seg.getText().length > 200) {
          tokens -= roughTokenCount(seg.getText()) - markerCost;
          seg.setText(TRUNCATION_MARKER);
          trimmed = true;
        }
      }
    }

    // Phase 3: 仍然超限时，截断较早的 skill 结果（保留最近一次）
    if (tokens > limit) {
      const skillSegs = this.collectSkillResultSegments(
        messages,
        skillIds,
        protectedIdxs,
      );
      for (let k = 0; k < skillSegs.length - 1 && tokens > limit; k++) {
        if (skillSegs[k].getText().length > 100) {
          tokens -= roughTokenCount(skillSegs[k].getText()) - markerCost;
          skillSegs[k].setText(TRUNCATION_MARKER);
          trimmed = true;
        }
      }
    }

    // Phase 4: 清理已全部截断的空壳消息
    if (trimmed) {
      this.compactTruncated(messages, protectedIdxs);
    }

    return trimmed;
  }

  // -----------------------------------------------------------------------
  // 保护窗口
  // -----------------------------------------------------------------------

  /** 构建受保护的消息索引集合。 */
  private buildProtectedIndexes(
    messages: TMsg[],
    aggressive: boolean,
  ): Set<number> {
    const idx = new Set<number>([0]);

    // 从末尾向前找最近 N 条真实 user 消息，标记到末尾全部受保护
    const rounds = aggressive
      ? Math.max(1, this.protectedUserRounds - 1)
      : this.protectedUserRounds;
    let userCount = 0;
    let windowStart = messages.length;

    for (let i = messages.length - 1; i >= 1; i--) {
      if (
        this.fmt.role(messages[i]) === 'user' &&
        this.fmt.isRealUserMessage(messages[i])
      ) {
        userCount++;
        if (userCount >= rounds) {
          windowStart = i;
          break;
        }
      }
    }

    for (let i = windowStart; i < messages.length; i++) {
      idx.add(i);
    }

    // 保护 tool_call / tool_result 配对完整性
    this.protectToolPairs(messages, idx);

    return idx;
  }

  /** 确保 tool_call 和 tool_result 要么都保护要么都不保护。 */
  private protectToolPairs(messages: TMsg[], idx: Set<number>): void {
    for (let i = 1; i < messages.length; i++) {
      const entries = this.fmt.toolCallEntries(messages[i]);
      if (entries.length === 0) continue;

      const callIds = new Set(entries.map((e) => e.id));
      const resultIdxs: number[] = [];

      for (let j = i + 1; j < messages.length; j++) {
        if (this.fmt.toolResultIds(messages[j]).some((r) => callIds.has(r))) {
          resultIdxs.push(j);
        }
      }

      const anyProtected =
        idx.has(i) || resultIdxs.some((ri) => idx.has(ri));
      if (anyProtected) {
        idx.add(i);
        for (const ri of resultIdxs) idx.add(ri);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Skill 结果识别
  // -----------------------------------------------------------------------

  /** 收集需要保护的工具调用 ID（run_skill_script 等）。 */
  private collectSkillResultIds(messages: TMsg[]): Set<string> {
    const ids = new Set<string>();
    for (const msg of messages) {
      for (const entry of this.fmt.toolCallEntries(msg)) {
        if (this.protectedToolNames.has(entry.name)) {
          ids.add(entry.id);
        }
      }
    }
    return ids;
  }

  /** 收集保护窗口外的 skill result 片段引用（从旧到新）。 */
  private collectSkillResultSegments(
    messages: TMsg[],
    skillIds: Set<string>,
    protectedIdxs: Set<number>,
  ): TruncatableSegment[] {
    const segs: TruncatableSegment[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (protectedIdxs.has(i)) continue;
      for (const seg of this.fmt.toolResultSegments(messages[i])) {
        if (seg.toolId && skillIds.has(seg.toolId)) {
          segs.push(seg);
        }
      }
    }
    return segs;
  }

  // -----------------------------------------------------------------------
  // 清理
  // -----------------------------------------------------------------------

  /** 移除已全部截断的 tool result 空壳消息。 */
  private compactTruncated(
    messages: TMsg[],
    protectedIdxs: Set<number>,
  ): void {
    // 先收集要移除的 tool_result 消息以及它们引用的 tool_call id
    const toolResultRemoveIdxs: number[] = [];
    const orphanedToolCallIds = new Set<string>();
    for (let i = 1; i < messages.length; i++) {
      if (protectedIdxs.has(i)) continue;
      if (this.fmt.isFullyTruncatedToolResult(messages[i], TRUNCATION_MARKER)) {
        toolResultRemoveIdxs.push(i);
        for (const id of this.fmt.toolResultIds(messages[i])) {
          orphanedToolCallIds.add(id);
        }
      }
    }

    // 收集对应的 assistant tool_call 消息：所有 tool_call entries 都被移除时整条消息可删
    const toolCallRemoveIdxs: number[] = [];
    if (orphanedToolCallIds.size > 0) {
      for (let i = 0; i < messages.length; i++) {
        if (protectedIdxs.has(i)) continue;
        if (toolResultRemoveIdxs.includes(i)) continue;
        const entries = this.fmt.toolCallEntries(messages[i]);
        if (
          entries.length > 0 &&
          entries.every((e) => orphanedToolCallIds.has(e.id))
        ) {
          toolCallRemoveIdxs.push(i);
        }
      }
    }

    // 合并、去重、降序删除，避免索引漂移导致 Anthropic 400 (tool_use 无对应 tool_result)
    const allRemove = Array.from(
      new Set([...toolResultRemoveIdxs, ...toolCallRemoveIdxs]),
    ).sort((a, b) => b - a);
    for (const idx of allRemove) {
      messages.splice(idx, 1);
    }
  }
}
