/**
 * 记忆系统规则（不含 soul.md 摘要，摘要移至 uncached section）。
 */
export function buildMemoryRulesSection(): string[] {
  return [
    '## 记忆系统',
    '',
    'soul.md 是跨会话持久化的唯一长期记忆。值得下次还能记住的信息就该写入，不要依赖对话历史。',
    '你只能看到最近几轮对话，更早的内容需用 recall_history 检索。',
    '修改记忆：先 read_memory 获取全文 → 在其基础上增删改 → write_memory 写回完整内容。',
    '',
    '### 应主动记录（不需要用户说"记住"）',
    '- 身份信息：姓名、称呼、生日、职业、所在城市',
    '- 家庭与关系：家人朋友的称呼和基本信息',
    '- 稳定偏好：饮食、兴趣、作息、交流风格',
    '- 重要事件：近期关注的事、项目计划、重要日期',
    '- 使用习惯：常用 skill、偏好回复风格、常问问题类型',
    '- 对话中自然流露的信息（"我刚从上海出差回来"→ 工作涉及出差）',
    '',
    '### 不需要记录',
    '- 一次性问题（"今天几号""帮我算个数"）',
    '- soul.md 中已有且未变化的信息',
  ];
}

import type { AgentRuntimeDeps } from '../../deps.js';
import { getDefaultAgentRuntimeDeps } from '../../deps.js';

/** soul.md 摘要截取最大字符数。 */
const SOUL_PREVIEW_MAX_CHARS = 1500;

/**
 * 用户记忆摘要（soul_content 前 N 字符快照）。
 * 放在 uncached section，因为用户记忆随对话频繁更新。
 */
export async function buildSoulPreviewSection(accountId: string): Promise<string[]> {
  return buildSoulPreviewSectionWithDeps(
    accountId,
    getDefaultAgentRuntimeDeps(),
  );
}

export async function buildSoulPreviewSectionWithDeps(
  accountId: string,
  deps: AgentRuntimeDeps = getDefaultAgentRuntimeDeps(),
): Promise<string[]> {
  if (!accountId) return [];

  try {
    const soulContent = await deps.memoryStore.read(accountId);
    if (!soulContent.trim()) return [];

    const lines: string[] = ['', '## 用户记忆摘要'];
    if (soulContent.length > SOUL_PREVIEW_MAX_CHARS) {
      lines.push(
        soulContent.slice(0, SOUL_PREVIEW_MAX_CHARS),
        '...(更多内容请用 read_memory 获取)',
      );
    } else {
      lines.push(soulContent);
    }
    return lines;
  } catch {
    return [];
  }
}
