import type { SkillContextEntry, ToolDefinition } from '../types.js';

export const FINAL_REPLY_TOOL_NAME = 'final_reply';

/** 循环内置的 final_reply 工具定义，不走 executeTool。 */
export const FINAL_REPLY_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: FINAL_REPLY_TOOL_NAME,
    description:
      '当你准备好向用户发送最终回复时，必须调用此工具。无论本轮是否调用过其他工具，都不要直接输出普通文本。',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: '发送给用户的最终回复文本',
        },
      },
      required: ['text'],
    },
  },
};

export const PROTOCOL_REPAIR_INSTRUCTION = [
  '协议错误：你刚才输出了普通文本。',
  '当前循环只接受两类合法动作：',
  '1. 调用一个或多个真实工具',
  `2. 调用 ${FINAL_REPLY_TOOL_NAME}(text=最终回复)`,
  '不要再输出普通 assistant 文本。',
  '如果需要继续处理，就发起工具调用；如果已经完成，就调用 final_reply。',
].join('\n');

/**
 * 将本次成功执行过的 skill 集合格式化为 footer，追加到 final_reply 文本末尾。
 * 返回空字符串表示不追加（例如集合为空时）。
 */
function formatSkillFooter(skills: Set<string>): string {
  if (skills.size === 0) return '';
  return `\n\n🛠️ ${Array.from(skills).join(' · ')}`;
}

export function buildFinalText(
  baseText: string,
  usedSkills: Set<string>,
): string | null {
  const footer = formatSkillFooter(usedSkills);
  return footer ? baseText + footer : baseText || null;
}

export function shouldShowSkillInFooter(entry: SkillContextEntry): boolean {
  // 解读类 skill 的结果已经是正文，footer 再展示一次内部 skill 名会显得突兀。
  return entry.skill !== 'xuanxue-jiedu';
}
