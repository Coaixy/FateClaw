import { describe, expect, it } from 'vitest';

import {
  buildUserPastedBoardInterpretGoal,
  canUseUserPastedBoardContent,
} from './user-pasted-board.js';

describe('user pasted board helpers', () => {
  it('builds an interpret-only goal with explicit source boundaries', () => {
    const goal = buildUserPastedBoardInterpretGoal({
      category: '八字',
      content: '乾造：甲子 乙丑 丙寅 丁卯',
      question: '看看事业',
    });

    expect(goal).toContain('用户通过“自贴盘面”入口提交已有盘面');
    expect(goal).toContain('类别：八字');
    expect(goal).toContain('用户问题：看看事业');
    expect(goal).toContain('乾造：甲子 乙丑 丙寅 丁卯');
    expect(goal).toContain('不要重排');
    expect(goal).toContain('content_source="user"');
  });

  it('allows user content only for explicit pasted-board input with valid payload', () => {
    expect(
      canUseUserPastedBoardContent('user_pasted_board', {
        category: '八字',
        content: '乾造：甲子 乙丑 丙寅 丁卯',
        question: '看看事业',
      }),
    ).toBe(true);
  });

  it('rejects non-pasted-board input kinds', () => {
    const pastedBoard = {
      category: '八字',
      content: '乾造：甲子 乙丑 丙寅 丁卯',
      question: '看看事业',
    };

    expect(canUseUserPastedBoardContent('normal', pastedBoard)).toBe(false);
    expect(canUseUserPastedBoardContent(undefined, pastedBoard)).toBe(false);
  });

  it('rejects missing or incomplete pasted-board payloads', () => {
    expect(canUseUserPastedBoardContent('user_pasted_board')).toBe(false);
    expect(
      canUseUserPastedBoardContent('user_pasted_board', {
        category: '八字',
        content: '',
        question: '看看事业',
      }),
    ).toBe(false);
    expect(
      canUseUserPastedBoardContent('user_pasted_board', {
        category: '八字',
        content: '   ',
        question: '看看事业',
      }),
    ).toBe(false);
  });
});
