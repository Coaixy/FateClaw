import { describe, expect, it } from 'vitest';

import {
  buildUserPastedBoardRequest,
  shouldPromptForPastedBoard,
} from '../../../features/chat/pasted-board-input';

describe('pasted board input helpers', () => {
  it('prompts for multi-line paste text', () => {
    expect(shouldPromptForPastedBoard('第一行\n第二行\n第三行')).toBe(true);
  });

  it('prompts for long single-paste text', () => {
    expect(shouldPromptForPastedBoard('甲'.repeat(220))).toBe(true);
  });

  it('does not prompt for short normal text', () => {
    expect(shouldPromptForPastedBoard('帮我排八字')).toBe(false);
  });

  it('builds the request payload for explicit pasted board input', () => {
    expect(
      buildUserPastedBoardRequest({
        category: '八字',
        content: '乾造：甲子 乙丑 丙寅 丁卯',
        question: '看看事业',
      }),
    ).toEqual({
      content: '看看事业',
      inputKind: 'user_pasted_board',
      pastedBoard: {
        category: '八字',
        content: '乾造：甲子 乙丑 丙寅 丁卯',
        question: '看看事业',
      },
    });
  });

  it('normalizes paipan display names to interpretation categories', () => {
    expectDisplayCategory('八字排盘', '八字');
    expectDisplayCategory('紫微斗数排盘', '紫微');
    expectDisplayCategory('六爻排盘', '六爻');
    expectDisplayCategory('经占排盘', '经占');
    expectDisplayCategory('奇门遁甲排盘', '奇门');
  });
});

function expectDisplayCategory(category: string, expected: string) {
  expect(
    buildUserPastedBoardRequest({
      category,
      content: '盘面原文',
      question: '看看事业',
    }).pastedBoard.category,
  ).toBe(expected);
}
