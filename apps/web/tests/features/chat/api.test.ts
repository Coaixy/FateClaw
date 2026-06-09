import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserPastedBoardInput } from '../../../features/chat/api';
import {
  buildChatSessionStreamUrl,
  chatSessionsApi,
} from '../../../features/chat/api';
import {
  getAiChatStreamReconnectDelay,
  getAiChatStreamErrorMessage,
  getAiChatSendErrorMessage,
  isRecoverableChatSendInterruption,
  sendChatSessionMessageWithOptions,
} from '../../../features/chat/hooks/use-chat-messages';

import { requestJson } from '@/lib/http/client';

vi.mock('@/lib/http/client', () => ({
  getApiBase: () => '',
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
        headers: {
          'x-no-compression': '1',
        },
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
        headers: {
          'x-no-compression': '1',
        },
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
        headers: {
          'x-no-compression': '1',
        },
      },
    );
  });

  it('passes abort signals to the send request', async () => {
    const controller = new AbortController();

    await chatSessionsApi.send('s 1', '普通问题', undefined, {
      signal: controller.signal,
    });

    expect(requestJsonMock).toHaveBeenCalledWith(
      '/api/chat-sessions/s/s%201/messages',
      {
        method: 'POST',
        body: JSON.stringify({
          content: '普通问题',
        }),
        exposeServerErrorMessage: true,
        headers: {
          'x-no-compression': '1',
        },
        signal: controller.signal,
      },
    );
  });
});

describe('chatSessionsApi.cancel', () => {
  beforeEach(() => {
    requestJsonMock.mockReset();
    requestJsonMock.mockResolvedValue({ success: true });
  });

  it('posts to the session cancel endpoint', async () => {
    await chatSessionsApi.cancel('s 1');

    expect(requestJsonMock).toHaveBeenCalledWith(
      '/api/chat-sessions/s/s%201/messages/cancel',
      {
        method: 'POST',
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

  it('passes request options to sender', async () => {
    const controller = new AbortController();
    const sender = vi.fn<typeof chatSessionsApi.send>().mockResolvedValue({
      text: 'ok',
      session_title: '选盘',
    });

    await sendChatSessionMessageWithOptions(
      sender,
      's 1',
      '看这个盘',
      undefined,
      { signal: controller.signal },
    );

    expect(sender).toHaveBeenCalledWith('s 1', '看这个盘', undefined, {
      signal: controller.signal,
    });
  });
});

describe('isRecoverableChatSendInterruption', () => {
  it('treats browser network disconnects as recoverable send interruptions', () => {
    expect(
      isRecoverableChatSendInterruption(
        Object.assign(new Error('网络连接失败'), { status: 0 }),
      ),
    ).toBe(true);
  });

  it('keeps server-side send failures non-recoverable', () => {
    expect(
      isRecoverableChatSendInterruption(
        Object.assign(new Error('AI 处理失败'), { status: 502 }),
      ),
    ).toBe(false);
    expect(isRecoverableChatSendInterruption(new Error('AI 处理失败'))).toBe(
      false,
    );
  });
});

describe('getAiChatStreamReconnectDelay', () => {
  it('uses capped exponential backoff for stream reconnects', () => {
    expect(getAiChatStreamReconnectDelay(0)).toBe(500);
    expect(getAiChatStreamReconnectDelay(3)).toBe(4000);
    expect(getAiChatStreamReconnectDelay(10)).toBe(8000);
  });
});

describe('getAiChatStreamErrorMessage', () => {
  it('prefers public stream error text', () => {
    expect(
      getAiChatStreamErrorMessage({
        publicErrorText: '自配模型调用失败',
        error: 'provider failed',
      }),
    ).toBe('自配模型调用失败');
  });

  it('falls back to raw stream errors', () => {
    expect(
      getAiChatStreamErrorMessage({
        error: 'model not found',
      }),
    ).toBe('model not found');
  });

  it('uses a generic message when the stream error is empty', () => {
    expect(
      getAiChatStreamErrorMessage({
        publicErrorText: '   ',
        error: '   ',
      }),
    ).toBe('抱歉，AI 服务暂时不可用，请稍后重试');
  });
});

describe('getAiChatSendErrorMessage', () => {
  it('shows reconnecting copy for generic request disconnects', () => {
    expect(getAiChatSendErrorMessage(new Error('请求失败，请检查后重试'))).toBe(
      '请求断开，正在重连',
    );
    expect(
      getAiChatSendErrorMessage(
        new Error('网络连接失败，请检查服务是否正常后重试'),
      ),
    ).toBe('请求断开，正在重连');
  });

  it('keeps specific server error messages visible', () => {
    expect(getAiChatSendErrorMessage(new Error('自配模型调用失败'))).toBe(
      '自配模型调用失败',
    );
  });
});

describe('buildChatSessionStreamUrl', () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: {
          protocol: 'https:',
          host: 'app.example.test',
        },
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
  });

  it('builds same-origin websocket URLs with stream ticket query auth', () => {
    expect(buildChatSessionStreamUrl('s 1', 'ticket value')).toBe(
      'wss://app.example.test/api/chat-sessions/s/s%201/stream?ticket=ticket%20value',
    );
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
