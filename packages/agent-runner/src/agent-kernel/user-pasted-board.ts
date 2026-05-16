import type { ChatInputKind, UserPastedBoardInput } from '../types.js';

export function canUseUserPastedBoardContent(
  inputKind: ChatInputKind | undefined,
  pastedBoard?: UserPastedBoardInput,
): boolean {
  return (
    inputKind === 'user_pasted_board' &&
    typeof pastedBoard?.category === 'string' &&
    pastedBoard.category.trim().length > 0 &&
    typeof pastedBoard.content === 'string' &&
    pastedBoard.content.trim().length > 0 &&
    typeof pastedBoard.question === 'string' &&
    pastedBoard.question.trim().length > 0
  );
}

export function buildUserPastedBoardInterpretGoal(
  pastedBoard: UserPastedBoardInput,
): string {
  return [
    '用户通过“自贴盘面”入口提交已有盘面，请按用户原文解读。',
    '这是用户明确声明的外部盘面材料，不是官方排盘 skill 产物。',
    `类别：${pastedBoard.category}`,
    `用户问题：${pastedBoard.question}`,
    `用户自贴盘面原文：\n${pastedBoard.content}`,
    '硬性边界：不要重排，不要提取参数调用 board-agent，不要声称这是官方排盘结果。',
    '调用 interpret_xuanxue 时必须传 content_source="user"，content 必须是用户自贴盘面原文，question 必须是用户问题。',
    '如果用户贴出的内容不足以回答本次问题，直接说明缺少哪些材料，不要补造缺失结构。',
  ].join('\n\n');
}
