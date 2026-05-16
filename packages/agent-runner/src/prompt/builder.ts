import { getContext } from '../context.js';
import type { SystemPromptParts, SystemPromptOptions } from './types.js';
import { buildCoreRulesSection } from './sections/core-rules.js';
import { buildToolsGuideSection } from './sections/tools-guide.js';
import {
  buildMemoryRulesSection,
  buildSoulPreviewSectionWithDeps,
} from './sections/memory-system.js';
import { buildSkillsIndexSection } from './sections/skills-index.js';
import { buildEnvironmentSection } from './sections/environment.js';
import { buildRemindersSectionWithDeps } from './sections/reminders.js';

/**
 * 构造 system prompt（分片返回）。
 *
 * 结构概览（按阅读顺序）:
 *
 * [Cached — 跨请求可复用，内容稳定]
 *   1. 核心规则        — 风格、时间、回复格式等全局约束
 *   2. 工具与 Skill    — 工具索引 + Skill 调用规范（含红线）
 *   3. 记忆系统规则    — soul.md 读写规则 + 自动记录策略
 *   4. 可用 Skills 索引 — metadata 列表 + 参数签名 + 用法
 *
 * [Uncached — 每次请求动态注入]
 *   5. 当前环境        — 精确时间 + 上下文预算状态
 *   6. 用户记忆摘要    — soul.md 前 N 字符快照（从 cached 移出，因频繁更新）
 *   7. 当前提醒列表    — 活跃的定时任务快照
 */
export async function buildSystemPrompt(
  options: SystemPromptOptions = {},
): Promise<SystemPromptParts> {
  const ctx = getContext();
  const accountId = ctx.accountId;
  const deps = options.deps;

  // Cached sections — 静态规则和能力声明
  const cached: string[] = [];
  cached.push(...buildCoreRulesSection());
  cached.push(...buildToolsGuideSection());
  cached.push(...buildMemoryRulesSection());
  cached.push(
    ...(await buildSkillsIndexSection(accountId, {
      deps,
    })),
  );

  // Uncached sections — 每请求动态内容
  const uncached: string[] = [];
  uncached.push(...buildEnvironmentSection(ctx.timezone, options.budgetInfo));

  // 已执行 skill 上下文（动态，放 uncached 避免破坏缓存）
  if (options.executedSkills && options.executedSkills.length > 0) {
    uncached.push(
      '',
      '## 本轮对话已执行的 Skill',
      `已执行: ${options.executedSkills.join(', ')}`,
      '这些 skill 的结果已在对话上下文中。用户追问时直接基于已有结果回答或调用解读类 skill，不要调用其他排盘类 skill。',
    );
  }
  uncached.push(...(await buildSoulPreviewSectionWithDeps(accountId, deps)));
  uncached.push(...(await buildRemindersSectionWithDeps(accountId, deps)));

  return {
    cached: cached.join('\n'),
    uncached: uncached.join('\n'),
  };
}
