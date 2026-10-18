import { act, useCallback, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionMessageListResponseDto } from '@fateclaw/contracts/chat';
import {
  chatSessionsApi,
  type ChatSession,
  type ChatSessionSendOptions,
  type ChatSessionStreamEvent,
  type Message,
} from '@/features/chat/api';
import {
  useChatDraft,
  type ChatDraftSubmission,
} from '@/features/chat/hooks/use-chat-draft';
import { useChatMessages } from '@/features/chat/hooks/use-chat-messages';
import {
  ChatSessionsProvider,
  useChatSessions,
} from '@/features/chat/hooks/use-chat-sessions';

vi.mock('@/features/chat/api', () => ({
  buildChatSessionStreamUrl: (sessionId: string) =>
    `ws://synthetic/${sessionId}`,
  chatSessionsApi: {
    create: vi.fn(),
    list: vi.fn(),
    messages: vi.fn(),
    send: vi.fn(),
    cancel: vi.fn(),
    createStreamTicket: vi.fn(),
  },
}));

vi.mock('@/features/auth/hooks/use-auth', () => {
  const user = { id: 'synthetic-user' };
  return { useAuth: () => ({ user, loading: false }) };
});

vi.mock('next/navigation', () => {
  const router = { push: vi.fn() };
  return { usePathname: () => '/ai-chat', useRouter: () => router };
});

const timestamp = '2026-10-17T00:00:00.000Z';
const sessions: ChatSession[] = ['A', 'B', 'created'].map((id) => ({
  id,
  account_id: 'synthetic-account',
  title: id,
  created_at: timestamp,
  updated_at: timestamp,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function message(
  id: string,
  bot = false,
  kind?: string,
  requestId?: string,
): Message {
  return {
    id,
    account_id: 'synthetic-account',
    sender: bot ? 'assistant' : 'user',
    sender_name: '',
    content: id,
    timestamp,
    is_from_me: bot,
    is_bot_message: bot,
    ...(kind ? { metadata: { kind, request_id: requestId } } : {}),
  };
}

function history(
  messages: Message[] = [],
  requestId?: string,
): SessionMessageListResponseDto {
  return {
    messages: [...messages].reverse(),
    processing: Boolean(requestId),
    processing_request_id: requestId ?? null,
  };
}

class SyntheticSocket {
  static instances: SyntheticSocket[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    SyntheticSocket.instances.push(this);
  }

  emit(event: ChatSessionStreamEvent) {
    this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
  }

  close() {
    this.closed = true;
    this.onclose?.();
  }
}

class SyntheticScroll extends EventTarget {
  scrollTop = 1000;
  scrollHeight = 3000;
  clientHeight = 600;
}

interface HarnessApi {
  chat: ReturnType<typeof useChatMessages>;
  draft: ReturnType<typeof useChatDraft>;
  selectedSession: string;
  selectSession: (id: string) => void;
  sendDraft: (options?: ChatSessionSendOptions) => Promise<boolean>;
}

let root: Root;
let latest: HarnessApi;
let scroll: SyntheticScroll;

function Harness() {
  const {
    selectedSession,
    selectedSessionRevision,
    setSelectedSession,
    createSession,
    touchSession,
    sessions: availableSessions,
  } = useChatSessions();
  const draft = useChatDraft({
    userId: 'synthetic-user',
    sessionId: selectedSession,
  });
  const submissionRef = useRef<ChatDraftSubmission | null>(null);
  const createSessionWithDraft = useCallback(
    (onCreated?: (session: ChatSession) => void) =>
      createSession((session) => {
        onCreated?.(session);
        draft.adoptDraft(session.id, submissionRef.current ?? undefined);
      }),
    [createSession, draft.adoptDraft],
  );
  const chat = useChatMessages({
    chatAvailable: true,
    selectedSession,
    selectedSessionRevision,
    sessions: availableSessions,
    createSession: createSessionWithDraft,
    touchSession,
  });
  chat.scrollRef.current = scroll as unknown as HTMLDivElement;
  latest = {
    chat,
    draft,
    selectedSession,
    selectSession: setSelectedSession,
    async sendDraft(options) {
      const submission = draft.takeDraft();
      submissionRef.current = submission;
      try {
        const sent = await chat.sendMessageWithOptions(
          submission.input.trim(),
          options,
        );
        if (!sent) draft.restoreDraft(submission);
        return sent;
      } finally {
        if (submissionRef.current === submission) submissionRef.current = null;
      }
    },
  };
  return null;
}

async function mount(initialSession = 'A') {
  window.location.search = initialSession ? `?sid=${initialSession}` : '';
  await act(async () =>
    root.render(
      <ChatSessionsProvider>
        <Harness />
      </ChatSessionsProvider>,
    ),
  );
}

async function selectSession(id: string) {
  await act(async () => latest.selectSession(id));
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      'Date',
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
    ],
  });
  vi.resetAllMocks();
  SyntheticSocket.instances = [];
  const entries = new Map<string, string>();
  const doc = Object.assign(new EventTarget(), {
    nodeType: 9,
    visibilityState: 'visible',
    activeElement: null,
    documentElement: { namespaceURI: 'http://www.w3.org/1999/xhtml' },
  });
  vi.stubGlobal('document', doc);
  const location = { search: '' };
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), {
      document: doc,
      HTMLIFrameElement: class {},
      location,
      history: {
        state: null,
        replaceState(_state: unknown, _title: string, target: string) {
          location.search = new URL(target, 'https://synthetic.invalid').search;
        },
      },
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      requestAnimationFrame: (callback: FrameRequestCallback) =>
        setTimeout(() => callback(Date.now()), 16),
      cancelAnimationFrame: clearTimeout,
      sessionStorage: {
        getItem: (key: string) => entries.get(key) ?? null,
        setItem: (key: string, value: string) => entries.set(key, value),
        removeItem: (key: string) => entries.delete(key),
      },
    }),
  );
  vi.stubGlobal('localStorage', { getItem: () => null });
  vi.stubGlobal('WebSocket', SyntheticSocket);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = Object.assign(new EventTarget(), {
    nodeType: 1,
    tagName: 'DIV',
    nodeName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: doc,
    textContent: '',
  });
  // The real React renderer needs only the root boundary because Harness emits no host nodes.
  root = createRoot(container as unknown as Element);
  scroll = new SyntheticScroll();
  vi.mocked(chatSessionsApi.create).mockResolvedValue(sessions[2]);
  vi.mocked(chatSessionsApi.list).mockResolvedValue(sessions);
  vi.mocked(chatSessionsApi.messages).mockResolvedValue(history());
  vi.mocked(chatSessionsApi.createStreamTicket).mockResolvedValue({
    ticket: 'synthetic-ticket',
    expiresAt: timestamp,
  });
  vi.mocked(chatSessionsApi.cancel).mockResolvedValue({ success: true });
  vi.mocked(chatSessionsApi.send).mockResolvedValue({
    text: '',
    accepted: true,
    request_id: 'request-1',
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('chat lifecycle', () => {
  it('loads a saved board notification while the assistant continues interpreting', async () => {
    await mount();
    const socket = SyntheticSocket.instances[0];
    const user = message('user');
    vi.mocked(chatSessionsApi.messages).mockResolvedValue(
      history([user], 'request-1'),
    );
    await act(async () => {
      expect(await latest.chat.sendMessage('帮我起盘')).toBe(true);
    });
    const board = {
      ...message('saved-board', true, 'board_result', 'request-1'),
      tool_context: JSON.stringify([
        {
          skill: 'bazi-paipan',
          output: '合成盘面',
          artifactData: { synthetic: true },
        },
      ]),
    };
    vi.mocked(chatSessionsApi.messages).mockResolvedValue(
      history([user, board], 'request-1'),
    );
    await act(async () =>
      socket.emit({
        type: 'message',
        requestId: 'request-1',
        text: '已生成八字排盘。',
        metadata: { kind: 'board_result' },
      }),
    );
    expect(
      latest.chat.messages.find((entry) => entry.id === 'saved-board')
        ?.tool_context,
    ).toBe(board.tool_context);
    expect(latest.chat.run.phase).toBe('running');
    expect(latest.chat.sending).toBe(true);
  });

  it('retains more than 200 expanded messages through a foreground refresh', async () => {
    const stored = Array.from({ length: 260 }, (_, index) => ({
      ...message(`message-${index}`),
      timestamp: new Date(Date.parse(timestamp) + index * 1000).toISOString(),
    }));
    vi.mocked(chatSessionsApi.messages).mockImplementation(
      async (_sessionId, limit = 50, before) =>
        history(
          stored
            .filter((entry) => !before || entry.timestamp < before)
            .slice(-limit),
        ),
    );
    await mount();
    for (let index = 0; index < 5; index += 1) {
      await act(async () => {
        scroll.scrollTop = 0;
        scroll.dispatchEvent(new Event('scroll'));
      });
    }
    expect(latest.chat.messages).toHaveLength(260);
    await act(async () => latest.chat.refreshMessages());
    expect(latest.chat.messages.map((entry) => entry.id)).toEqual(
      stored.map((entry) => entry.id),
    );
    expect(
      vi
        .mocked(chatSessionsApi.messages)
        .mock.calls.every(([, limit]) => limit === 50),
    ).toBe(true);
  });

  it('waits for admission before cancelling and keeps the live request on cancellation failure', async () => {
    await mount();
    const socket = SyntheticSocket.instances[0];
    const admission =
      deferred<Awaited<ReturnType<typeof chatSessionsApi.send>>>();
    vi.mocked(chatSessionsApi.send).mockReturnValueOnce(admission.promise);
    vi.mocked(chatSessionsApi.cancel).mockRejectedValue(
      new Error('Cancellation rejected'),
    );
    vi.mocked(chatSessionsApi.messages).mockResolvedValue(
      history([message('sent')], 'request-1'),
    );
    let sent!: Promise<boolean>;
    let stopped!: Promise<boolean>;
    await act(async () => {
      sent = latest.chat.sendMessage('Original message');
    });
    await act(async () => {
      stopped = latest.chat.stopGenerating();
    });
    expect(chatSessionsApi.cancel).not.toHaveBeenCalled();
    expect(latest.chat.stopping).toBe(true);
    await act(async () => {
      admission.resolve({ text: '', accepted: true, request_id: 'request-1' });
      expect(await sent).toBe(true);
      expect(await stopped).toBe(false);
    });
    expect(socket.closed).toBe(false);
    expect(latest.chat.sending).toBe(true);
    expect(latest.chat.run.phase).not.toBe('stopped');
    let retried!: boolean;
    await act(async () => {
      retried = await latest.chat.retrySending();
    });
    expect(retried).toBe(false);
    expect(chatSessionsApi.send).toHaveBeenCalledTimes(1);
    expect(chatSessionsApi.cancel).toHaveBeenCalledTimes(2);
    expect(socket.closed).toBe(false);
  });

  it('does not add an old-session reconnect notice when history fails after selecting another session', async () => {
    await mount();
    const refresh = deferred<SessionMessageListResponseDto>();
    vi.mocked(chatSessionsApi.messages).mockImplementation(async (id) =>
      id === 'A' ? refresh.promise : history([message('B-only')]),
    );
    let sent!: Promise<boolean>;
    await act(async () => {
      sent = latest.chat.sendMessage('A message');
    });
    await selectSession('B');
    await act(async () => {
      refresh.reject(new Error('A history unavailable'));
      expect(await sent).toBe(true);
    });
    expect(latest.chat.messages.map((entry) => entry.id)).toEqual(['B-only']);
    expect(latest.chat.sending).toBe(false);
    expect(latest.chat.run).toMatchObject({ sessionId: 'B', phase: 'idle' });
  });

  it('does not stop a newer request when an earlier cancellation returns after revisiting the session', async () => {
    await mount();
    vi.mocked(chatSessionsApi.messages).mockResolvedValue(
      history([message('first-user')], 'request-1'),
    );
    await act(async () => {
      await latest.chat.sendMessage('First request');
    });
    const cancellation = deferred<{ success: true }>();
    vi.mocked(chatSessionsApi.cancel).mockReturnValueOnce(cancellation.promise);
    let stopped!: Promise<boolean>;
    await act(async () => {
      stopped = latest.chat.stopGenerating();
    });
    vi.mocked(chatSessionsApi.messages).mockImplementation(async (id) =>
      history(id === 'A' ? [message('first-user')] : []),
    );
    await selectSession('B');
    await selectSession('A');
    vi.mocked(chatSessionsApi.send).mockResolvedValueOnce({
      text: '',
      accepted: true,
      request_id: 'request-2',
    });
    vi.mocked(chatSessionsApi.messages).mockResolvedValue(
      history([message('first-user'), message('second-user')], 'request-2'),
    );
    await act(async () => {
      expect(await latest.chat.sendMessage('Second request')).toBe(true);
    });
    const newSocket = SyntheticSocket.instances.at(-1);
    await act(async () => {
      cancellation.resolve({ success: true });
      await stopped;
    });
    expect(latest.chat.run).toMatchObject({
      sessionId: 'A',
      requestId: 'request-2',
      phase: 'queued',
    });
    expect(latest.chat.sending).toBe(true);
    expect(newSocket?.closed).toBe(false);
  });

  it('returns a late explicit POST rejection as failure and restores only the submitting session draft', async () => {
    await mount();
    const admission =
      deferred<Awaited<ReturnType<typeof chatSessionsApi.send>>>();
    vi.mocked(chatSessionsApi.send).mockReturnValueOnce(admission.promise);
    vi.mocked(chatSessionsApi.messages).mockResolvedValue(
      history([message('B-only')]),
    );
    await act(async () => latest.draft.setInput('A unsent message'));
    let sent!: Promise<boolean>;
    await act(async () => {
      sent = latest.sendDraft();
    });
    await selectSession('B');
    await act(async () => latest.draft.setInput('B next question'));
    let result!: boolean;
    await act(async () => {
      admission.reject(
        Object.assign(new Error('Insufficient balance'), { status: 402 }),
      );
      result = await sent;
    });
    expect(result).toBe(false);
    expect(latest.draft.input).toBe('B next question');
    expect(latest.chat.messages.map((entry) => entry.id)).toEqual(['B-only']);
    await selectSession('A');
    expect(latest.draft.input).toBe('A unsent message');
  });

  it('preserves the initial send and next draft when adopting its created session and retrying', async () => {
    const creation = deferred<ChatSession>();
    const admission =
      deferred<Awaited<ReturnType<typeof chatSessionsApi.send>>>();
    vi.mocked(chatSessionsApi.create).mockReturnValueOnce(creation.promise);
    vi.mocked(chatSessionsApi.send).mockReturnValueOnce(admission.promise);
    await mount('');
    await act(async () => latest.draft.setInput('Original first message'));
    let sent!: Promise<boolean>;
    await act(async () => {
      sent = latest.sendDraft({ selectedBoardMessageId: 'board-1' });
    });
    await act(async () => latest.draft.setInput('Next question'));
    await act(async () => creation.resolve(sessions[2]));
    expect(latest.chat.sending).toBe(true);
    expect(latest.draft.input).toBe('Next question');
    expect(chatSessionsApi.send).toHaveBeenCalledTimes(1);
    vi.mocked(chatSessionsApi.messages).mockResolvedValue(
      history([message('first-user')], 'request-1'),
    );
    await act(async () => {
      admission.resolve({ text: '', accepted: true, request_id: 'request-1' });
      expect(await sent).toBe(true);
    });
    await act(async () => {
      expect(await latest.chat.retrySending()).toBe(true);
    });
    expect(chatSessionsApi.send).toHaveBeenCalledTimes(2);
    expect(vi.mocked(chatSessionsApi.send).mock.calls[1].slice(0, 3)).toEqual([
      'created',
      'Original first message',
      { selectedBoardMessageId: 'board-1' },
    ]);
    expect(latest.draft.input).toBe('Next question');
  });

  it('keeps a manual session selection and its draft when an earlier creation finishes', async () => {
    const creation = deferred<ChatSession>();
    vi.mocked(chatSessionsApi.create).mockReturnValueOnce(creation.promise);
    await mount('');
    await act(async () => latest.draft.setInput('Original unsaved message'));
    let sent!: Promise<boolean>;
    await act(async () => {
      sent = latest.sendDraft();
    });
    await selectSession('B');
    await act(async () => latest.draft.setInput('B next question'));
    await act(async () => {
      creation.resolve(sessions[2]);
      expect(await sent).toBe(false);
    });
    expect(latest.selectedSession).toBe('B');
    expect(latest.draft.input).toBe('B next question');
    expect(latest.chat.sending).toBe(false);
    expect(chatSessionsApi.send).not.toHaveBeenCalled();
    await selectSession('');
    expect(latest.draft.input).toBe('Original unsaved message');
  });

  it('reports cancellation failure against the created session when stopping before its id exists', async () => {
    const creation = deferred<ChatSession>();
    const admission =
      deferred<Awaited<ReturnType<typeof chatSessionsApi.send>>>();
    vi.mocked(chatSessionsApi.create).mockReturnValueOnce(creation.promise);
    vi.mocked(chatSessionsApi.send).mockReturnValueOnce(admission.promise);
    vi.mocked(chatSessionsApi.cancel).mockRejectedValueOnce(
      new Error('Cancellation rejected'),
    );
    await mount('');
    let sent!: Promise<boolean>;
    let stopped!: Promise<boolean>;
    await act(async () => {
      sent = latest.chat.sendMessage('First message');
    });
    await act(async () => {
      stopped = latest.chat.stopGenerating();
    });
    await act(async () => creation.resolve(sessions[2]));
    expect(chatSessionsApi.cancel).not.toHaveBeenCalled();
    vi.mocked(chatSessionsApi.messages).mockResolvedValue(
      history([message('first-user')], 'request-1'),
    );
    await act(async () => {
      admission.resolve({ text: '', accepted: true, request_id: 'request-1' });
      await sent;
      expect(await stopped).toBe(false);
    });
    expect(chatSessionsApi.cancel).toHaveBeenCalledWith('created');
    expect(latest.chat.run).toMatchObject({
      sessionId: 'created',
      phase: 'running',
      error: 'Cancellation rejected',
    });
    expect(latest.chat.stopping).toBe(false);
    expect(latest.chat.sending).toBe(true);
    expect(SyntheticSocket.instances.at(-1)?.closed).toBe(false);
  });

  it('keeps a persisted execution error failed when final reconciliation finishes', async () => {
    await mount();
    const socket = SyntheticSocket.instances[0];
    vi.mocked(chatSessionsApi.messages).mockResolvedValue(
      history([message('user')], 'request-1'),
    );
    await act(async () => {
      expect(await latest.chat.sendMessage('Run this')).toBe(true);
    });
    vi.mocked(chatSessionsApi.messages).mockResolvedValue(
      history([
        message('user'),
        message('failed-reply', true, 'error', 'request-1'),
      ]),
    );
    await act(async () =>
      socket.emit({
        type: 'final',
        status: 'error',
        text: 'Execution failed',
        requestId: 'request-1',
      }),
    );
    expect(latest.chat.run.phase).toBe('failed');
    expect(latest.chat.sending).toBe(false);
  });

  it('keeps a persisted successful result completed if it arrives before cancellation acknowledgement', async () => {
    await mount();
    const socket = SyntheticSocket.instances[0];
    vi.mocked(chatSessionsApi.messages).mockResolvedValue(
      history([message('user')], 'request-1'),
    );
    await act(async () => {
      expect(await latest.chat.sendMessage('Run this')).toBe(true);
    });
    const cancellation = deferred<{ success: true }>();
    vi.mocked(chatSessionsApi.cancel).mockReturnValueOnce(cancellation.promise);
    let stopped!: Promise<boolean>;
    await act(async () => {
      stopped = latest.chat.stopGenerating();
    });
    vi.mocked(chatSessionsApi.messages).mockResolvedValue(
      history([
        message('user'),
        message('successful-reply', true, 'final', 'request-1'),
      ]),
    );
    await act(async () =>
      socket.emit({
        type: 'final',
        status: 'success',
        text: 'Finished',
        requestId: 'request-1',
      }),
    );
    await act(async () => {
      cancellation.resolve({ success: true });
      await stopped;
    });
    expect(latest.chat.run.phase).toBe('completed');
    expect(latest.chat.sending).toBe(false);
  });

  it('keeps an uncertain POST syncing with its optimistic user when only a previous final is persisted', async () => {
    vi.mocked(chatSessionsApi.messages).mockResolvedValue(
      history([
        message('old-user'),
        message('old-final', true, 'final', 'request-old'),
      ]),
    );
    await mount();
    vi.mocked(chatSessionsApi.send).mockRejectedValueOnce(
      Object.assign(new Error('网络连接失败，请检查服务是否正常后重试'), {
        status: 0,
      }),
    );
    await act(async () => {
      expect(await latest.chat.sendMessage('New uncertain message')).toBe(true);
    });
    expect(latest.chat.run.phase).toBe('syncing');
    expect(latest.chat.sending).toBe(true);
    expect(
      latest.chat.messages.filter((entry) => !entry.is_bot_message).at(-1),
    ).toMatchObject({ content: 'New uncertain message' });
  });

  it('accepts a later request from another tab and rejects an old final during a new admission', async () => {
    const firstTurn = [
      message('first-user'),
      message('first-final', true, 'final', 'request-1'),
    ];
    vi.mocked(chatSessionsApi.messages).mockResolvedValue(history(firstTurn));
    await mount();
    const socket = SyntheticSocket.instances[0];
    expect(latest.chat.run).toMatchObject({
      phase: 'completed',
      requestId: 'request-1',
    });
    const secondTurn = [...firstTurn, message('second-user')];
    vi.mocked(chatSessionsApi.messages).mockResolvedValue(
      history(secondTurn, 'request-2'),
    );
    await act(async () =>
      socket.emit({ type: 'agent_start', requestId: 'request-2' }),
    );
    expect(latest.chat.run).toMatchObject({
      phase: 'running',
      requestId: 'request-2',
    });
    expect(latest.chat.sending).toBe(true);
    vi.mocked(chatSessionsApi.messages).mockResolvedValue(
      history([
        ...secondTurn,
        message('second-final', true, 'final', 'request-2'),
      ]),
    );
    await act(async () =>
      socket.emit({
        type: 'final',
        status: 'success',
        text: 'Second result',
        requestId: 'request-2',
      }),
    );
    expect(latest.chat.run.phase).toBe('completed');
    const admission =
      deferred<Awaited<ReturnType<typeof chatSessionsApi.send>>>();
    vi.mocked(chatSessionsApi.send).mockReturnValueOnce(admission.promise);
    let sent!: Promise<boolean>;
    await act(async () => {
      sent = latest.chat.sendMessage('Third request');
    });
    await act(async () =>
      socket.emit({
        type: 'final',
        status: 'success',
        text: 'Late first result',
        requestId: 'request-1',
      }),
    );
    expect(latest.chat.run).toMatchObject({ phase: 'queued', requestId: null });
    expect(
      latest.chat.messages.some(
        (entry) => entry.content === 'Late first result',
      ),
    ).toBe(false);
    vi.mocked(chatSessionsApi.messages).mockResolvedValue(
      history([message('third-user')], 'request-3'),
    );
    await act(async () => {
      admission.resolve({ text: '', accepted: true, request_id: 'request-3' });
      expect(await sent).toBe(true);
    });
    expect(latest.chat.run).toMatchObject({
      phase: 'queued',
      requestId: 'request-3',
    });
  });
});
