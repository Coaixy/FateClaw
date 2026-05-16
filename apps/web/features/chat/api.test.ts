import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserPastedBoardInput } from './api';
import { chatSessionsApi } from './api';
import { sendChatSessionMessageWithOptions } from './hooks/use-chat-messages';

import { requestJson } from '@/lib/http/client';

vi.mock('@/lib/http/client', () => ({
  requestJson: vi.fn(),
}));

const requestJsonMock = vi.mocked(requestJson);

const pastedBoard: UserPastedBoardInput = {
  category: '八字',
  content: '乾造：甲子 乙丑 丙寅 丁卯',
  question: '看看事业',
};

describe('chatSessionsApi.send', () => {
  beforeEach(() => {
    requestJsonMock.mockReset();
    requestJsonMock.mockResolvedValue({
      text: 'ok',
      session_title: '事业',
    });
  });

  it('serializes user pasted-board send options', async () => {
    await chatSessionsApi.send('s 1', '看看事业', {
      inputKind: 'user_pasted_board',
      pastedBoard,
    });

    expect(requestJsonMock).toHaveBeenCalledWith(
      '/api/chat-sessions/s/s%201/messages',
      {
        method: 'POST',
        body: JSON.stringify({
          content: '看看事业',
          input_kind: 'user_pasted_board',
          pasted_board: pastedBoard,
        }),
        exposeServerErrorMessage: true,
      },
    );
  });

  it('serializes selected board send options without pasted board', async () => {
    await chatSessionsApi.send('s 1', '看这个盘', {
      selectedBoardMessageId: 'board-1',
    });

    expect(requestJsonMock).toHaveBeenCalledWith(
      '/api/chat-sessions/s/s%201/messages',
      {
        method: 'POST',
        body: JSON.stringify({
          content: '看这个盘',
          selected_board_message_id: 'board-1',
        }),
        exposeServerErrorMessage: true,
      },
    );
  });

  it('serializes normal send options without pasted board', async () => {
    await chatSessionsApi.send('s 1', '普通问题', { inputKind: 'normal' });

    expect(requestJsonMock).toHaveBeenCalledWith(
      '/api/chat-sessions/s/s%201/messages',
      {
        method: 'POST',
        body: JSON.stringify({
          content: '普通问题',
          input_kind: 'normal',
        }),
        exposeServerErrorMessage: true,
      },
    );
  });
});

describe('sendChatSessionMessageWithOptions', () => {
  beforeEach(() => {
    requestJsonMock.mockReset();
  });

  it('passes user pasted-board options to sender', async () => {
    const sender = vi.fn<typeof chatSessionsApi.send>().mockResolvedValue({
      text: 'ok',
      session_title: '事业',
    });

    await sendChatSessionMessageWithOptions(sender, 's 1', '看看事业', {
      inputKind: 'user_pasted_board',
      pastedBoard,
    });

    expect(sender).toHaveBeenCalledWith('s 1', '看看事业', {
      inputKind: 'user_pasted_board',
      pastedBoard,
    });
  });

  it('passes selected board options to sender', async () => {
    const sender = vi.fn<typeof chatSessionsApi.send>().mockResolvedValue({
      text: 'ok',
      session_title: '选盘',
    });

    await sendChatSessionMessageWithOptions(sender, 's 1', '看这个盘', {
      selectedBoardMessageId: 'board-1',
    });

    expect(sender).toHaveBeenCalledWith('s 1', '看这个盘', {
      selectedBoardMessageId: 'board-1',
    });
  });
});

function assertChatSessionSendOptionsTypes() {
  void chatSessionsApi.send('s 1', '看看事业', {
    inputKind: 'user_pasted_board',
    pastedBoard,
  });

  // @ts-expect-error pastedBoard is required for user_pasted_board input.
  void chatSessionsApi.send('s 1', '看看事业', {
    inputKind: 'user_pasted_board',
  });

  // @ts-expect-error pastedBoard is only valid with user_pasted_board input.
  void chatSessionsApi.send('s 1', '看看事业', {
    pastedBoard,
  });
}
