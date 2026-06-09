import { describe, expect, it } from 'vitest';

import { normalizeChatSessionMessageBody } from '../../../src/modules/chat/pasted-board-input.js';

describe('normalizeChatSessionMessageBody', () => {
  it('normalizes a regular chat message', () => {
    const result = normalizeChatSessionMessageBody({
      content: '帮我按 1990 年生日排八字',
      selected_board_message_id: '   ',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      content: '帮我按 1990 年生日排八字',
      selectedBoardMessageId: undefined,
      inputKind: 'normal',
      pastedBoard: undefined,
    });
  });

  it('normalizes an explicit user pasted board message', () => {
    const result = normalizeChatSessionMessageBody({
      input_kind: 'user_pasted_board',
      selected_board_message_id: ' board-msg-1 ',
      pasted_board: {
        category: ' 八字 ',
        content: ' 乾造：甲子 乙丑 丙寅 丁卯 ',
        question: ' 看看事业 ',
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.content).toBe('看看事业');
    expect(result.data.selectedBoardMessageId).toBe('board-msg-1');
    expect(result.data.inputKind).toBe('user_pasted_board');
    expect(result.data.pastedBoard).toEqual({
      category: '八字',
      content: '乾造：甲子 乙丑 丙寅 丁卯',
      question: '看看事业',
    });
  });

  it('rejects pasted-board input without board content', () => {
    const result = normalizeChatSessionMessageBody({
      content: '看看事业',
      input_kind: 'user_pasted_board',
      pasted_board: {
        category: '八字',
        content: '   ',
        question: '看看事业',
      },
    });

    expect(result).toEqual({
      ok: false,
      statusCode: 400,
      error: '自贴盘面原文不能为空',
    });
  });

  it('rejects unknown input kinds', () => {
    const result = normalizeChatSessionMessageBody({
      content: 'hello',
      input_kind: 'raw_board',
    });

    expect(result).toEqual({
      ok: false,
      statusCode: 400,
      error: '未知消息输入类型',
    });
  });
});
