'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import {
  buildChatSessionStreamUrl,
  chatSessionsApi,
  type ChatSession,
  type ChatSessionSendOptions,
  type ChatSessionStreamEvent,
  type Message,
} from '../api';
import {
  areMessagesEqual,
  hasFinalAssistantAfterLatestUser,
  isNearBottom,
} from '../utils/display';
import { sanitizeToolPath } from '../utils/tool-path';

const DEFAULT_AI_CHAT_SESSION_TITLE = '未设置标题';
const CHAT_POLL_INTERVAL_MS = 1200;

export type ChatMessageSendOptions = ChatSessionSendOptions;

type ChatSessionSender = typeof chatSessionsApi.send;

function appendActiveStreamingMessage(
  nextMessages: Message[],
  previousMessages: Message[],
  activeStreamingMessageIds: string[],
) {
  if (activeStreamingMessageIds.length === 0) {
    return nextMessages;
  }

  const existingIds = new Set(nextMessages.map((message) => message.id));
  const streamingMessages = activeStreamingMessageIds.flatMap((id) => {
    if (existingIds.has(id)) return [];
    const streamingMessage = previousMessages.find(
      (message) => message.id === id,
    );
    return streamingMessage ? [streamingMessage] : [];
  });

  return streamingMessages.length > 0
    ? [...nextMessages, ...streamingMessages]
    : nextMessages;
}

function readToolPath(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const path = (value as { path?: unknown }).path;
  return typeof path === 'string' && path.trim()
    ? sanitizeToolPath(path)
    : undefined;
}

function getToolLabel(toolName: string): string {
  return toolName;
}

function buildToolTraceContent(args: {
  toolName: string;
  status: 'running' | 'completed' | 'failed';
  path?: string;
}) {
  const label = getToolLabel(args.toolName);
  const suffix =
    args.status === 'running'
      ? '中'
      : args.status === 'failed'
        ? '失败'
        : '完成';
  return args.path ? `${label}: ${args.path} ${suffix}` : `${label}${suffix}`;
}

export async function sendChatSessionMessageWithOptions(
  sender: ChatSessionSender,
  sessionId: string,
  content: string,
  sendOptions?: ChatMessageSendOptions,
) {
  return sender(sessionId, content, sendOptions);
}

export function useChatMessages(options: {
  chatAvailable: boolean;
  selectedSession: string;
  sessions: ChatSession[];
  createSession: () => Promise<ChatSession | null>;
  touchSession: (sessionId: string, patch: Partial<ChatSession>) => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [awaitingRefresh, setAwaitingRefresh] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pollInFlightRef = useRef(false);
  const sendingRef = useRef(false);
  const processingRef = useRef(false);
  const awaitingRefreshRef = useRef(false);
  const activeSessionRef = useRef('');
  const shouldAutoScrollRef = useRef(true);
  const creatingRef = useRef(false);
  const streamSocketRef = useRef<WebSocket | null>(null);
  const streamingMessageEntriesRef = useRef<Array<{ key: string; id: string }>>(
    [],
  );
  const toolTraceMessageEntriesRef = useRef<
    Array<{ key: string; id: string; args?: unknown }>
  >([]);
  const thinkingMessageEntriesRef = useRef<Array<{ key: string; id: string }>>(
    [],
  );
  const latestStreamingMessageKeyRef = useRef<string | null>(null);
  const latestThinkingMessageKeyRef = useRef<string | null>(null);
  const streamingSequenceRef = useRef(0);
  const toolTraceSequenceRef = useRef(0);
  const thinkingSequenceRef = useRef(0);
  const isPending = sending || processing || awaitingRefresh;

  const getActiveStreamingMessageIds = useCallback(
    () => [
      ...thinkingMessageEntriesRef.current.map((entry) => entry.id),
      ...streamingMessageEntriesRef.current.map((entry) => entry.id),
    ],
    [],
  );

  const resetStreamingMessageRefs = useCallback(() => {
    streamingMessageEntriesRef.current = [];
    latestStreamingMessageKeyRef.current = null;
    latestThinkingMessageKeyRef.current = null;
    toolTraceMessageEntriesRef.current = [];
    thinkingMessageEntriesRef.current = [];
  }, []);

  const beginStreamingAssistantTurn = useCallback((turnIndex?: number) => {
    const key =
      typeof turnIndex === 'number'
        ? `turn-${turnIndex}`
        : `turn-${streamingSequenceRef.current}`;
    latestStreamingMessageKeyRef.current = key;
    return key;
  }, []);

  useEffect(() => {
    sendingRef.current = sending;
  }, [sending]);

  useEffect(() => {
    processingRef.current = processing;
  }, [processing]);

  useEffect(() => {
    awaitingRefreshRef.current = awaitingRefresh;
  }, [awaitingRefresh]);

  useEffect(() => {
    activeSessionRef.current = options.selectedSession || '';
  }, [options.selectedSession]);

  const loadMessages = useCallback(
    async (sessionId: string, loadOptions?: { background?: boolean }) => {
      if (!sessionId) return false;

      const isBackground = loadOptions?.background ?? false;
      if (!isBackground) {
        setLoading(true);
      }

      try {
        const data = await chatSessionsApi.messages(sessionId);
        if (activeSessionRef.current !== sessionId) return true;

        const nextMessages = data.messages.reverse();
        const activeStreamingMessageIds = getActiveStreamingMessageIds();
        const streamingResolved =
          isBackground &&
          activeStreamingMessageIds.length > 0 &&
          hasFinalAssistantAfterLatestUser(nextMessages);
        if (streamingResolved) {
          resetStreamingMessageRefs();
        }
        const canFollow =
          !isBackground ||
          !scrollRef.current ||
          shouldAutoScrollRef.current ||
          isNearBottom(scrollRef.current);

        setMessages((previous) => {
          const visibleMessages =
            isBackground && !streamingResolved
              ? appendActiveStreamingMessage(
                  nextMessages,
                  previous,
                  activeStreamingMessageIds,
                )
              : nextMessages;

          return isBackground &&
            visibleMessages.length === 0 &&
            previous.length > 0
            ? previous
            : areMessagesEqual(previous, visibleMessages)
              ? previous
              : ((shouldAutoScrollRef.current = canFollow), visibleMessages);
        });
        setProcessing(data.processing);
        setAwaitingRefresh(
          isBackground &&
            activeStreamingMessageIds.length > 0 &&
            !streamingResolved,
        );
        return true;
      } catch {
        if (activeSessionRef.current === sessionId && !isBackground) {
          setMessages([]);
        }
        return false;
      } finally {
        if (activeSessionRef.current === sessionId && !isBackground) {
          setLoading(false);
        }
      }
    },
    [getActiveStreamingMessageIds, resetStreamingMessageRefs],
  );

  useEffect(() => {
    if (options.selectedSession) {
      setProcessing(false);
      setAwaitingRefresh(false);
      void loadMessages(options.selectedSession, {
        background: sendingRef.current,
      });
      return;
    }

    setLoading(false);
    setMessages([]);
    setSending(false);
    setProcessing(false);
    setAwaitingRefresh(false);
  }, [loadMessages, options.selectedSession]);

  const pollMessages = useCallback(async () => {
    const sessionId = options.selectedSession;
    if (
      !sessionId ||
      pollInFlightRef.current ||
      document.visibilityState === 'hidden' ||
      (!processingRef.current && !awaitingRefreshRef.current)
    ) {
      return;
    }

    pollInFlightRef.current = true;
    try {
      await loadMessages(sessionId, { background: true });
    } finally {
      pollInFlightRef.current = false;
    }
  }, [loadMessages, options.selectedSession]);

  useEffect(() => {
    if (!options.selectedSession || (!processing && !awaitingRefresh)) return;

    void pollMessages();

    const intervalId = window.setInterval(() => {
      void pollMessages();
    }, CHAT_POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [awaitingRefresh, options.selectedSession, pollMessages, processing]);

  useEffect(() => {
    if (!options.selectedSession) return;

    const handleWindowFocus = () => {
      void pollMessages();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void pollMessages();
      }
    };

    window.addEventListener('focus', handleWindowFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('focus', handleWindowFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [options.selectedSession, pollMessages]);

  const upsertStreamingAssistantMessage = useCallback(
    (sessionId: string, content: string, streamKey?: string | null) => {
      const key =
        streamKey ??
        latestStreamingMessageKeyRef.current ??
        `message-${streamingSequenceRef.current}`;
      let entry = streamingMessageEntriesRef.current.find(
        (item) => item.key === key,
      );
      if (!entry) {
        entry = {
          key,
          id: `stream-bot-${Date.now()}-${streamingSequenceRef.current}`,
        };
        streamingSequenceRef.current += 1;
        streamingMessageEntriesRef.current = [
          ...streamingMessageEntriesRef.current,
          entry,
        ];
      }
      latestStreamingMessageKeyRef.current = key;
      const accountId =
        options.sessions.find((session) => session.id === sessionId)
          ?.account_id ?? 'web';

      setMessages((previous) => {
        const existingIndex = previous.findIndex(
          (message) => message.id === entry.id,
        );
        if (existingIndex >= 0) {
          const next = [...previous];
          next[existingIndex] = {
            ...next[existingIndex],
            content,
            timestamp: new Date().toISOString(),
          };
          return next;
        }

        return [
          ...previous,
          {
            id: entry.id,
            account_id: accountId,
            sender: '',
            sender_name: '',
            content,
            timestamp: new Date().toISOString(),
            is_from_me: true,
            is_bot_message: true,
            metadata: {
              kind: 'streaming',
            },
          },
        ];
      });
    },
    [options.sessions],
  );

  const upsertLatestStreamingAssistantMessage = useCallback(
    (sessionId: string, content: string) => {
      upsertStreamingAssistantMessage(
        sessionId,
        content,
        latestStreamingMessageKeyRef.current,
      );
    },
    [upsertStreamingAssistantMessage],
  );

  const upsertThinkingMessage = useCallback(
    (sessionId: string, content: string, turnIndex?: number) => {
      const text = content.trim();
      if (!text) return;

      const key =
        typeof turnIndex === 'number'
          ? `thinking-${turnIndex}`
          : latestThinkingMessageKeyRef.current ??
            `thinking-${thinkingSequenceRef.current}`;
      let entry = thinkingMessageEntriesRef.current.find(
        (item) => item.key === key,
      );
      if (!entry) {
        entry = {
          key,
          id: `thinking-${Date.now()}-${thinkingSequenceRef.current}`,
        };
        thinkingSequenceRef.current += 1;
        thinkingMessageEntriesRef.current = [
          ...thinkingMessageEntriesRef.current,
          entry,
        ];
      }
      latestThinkingMessageKeyRef.current = key;

      const accountId =
        options.sessions.find((session) => session.id === sessionId)
          ?.account_id ?? 'web';

      setMessages((previous) => {
        const existingIndex = previous.findIndex(
          (message) => message.id === entry.id,
        );
        const nextMessage: Message = {
          id: entry.id,
          account_id: accountId,
          sender: '',
          sender_name: '',
          content: text,
          timestamp: new Date().toISOString(),
          is_from_me: true,
          is_bot_message: true,
          metadata: {
            kind: 'thinking',
            stage: 'thinking',
            workflow: 'pi_runtime',
          },
        };

        if (existingIndex >= 0) {
          const next = [...previous];
          next[existingIndex] = nextMessage;
          return next;
        }

        return [...previous, nextMessage];
      });
    },
    [options.sessions],
  );

  const upsertToolTraceMessage = useCallback(
    (
      sessionId: string,
      content: string,
      traceOptions: {
        key: string;
        toolName: string;
        status: 'running' | 'completed' | 'failed';
        path?: string;
        args?: unknown;
      },
    ) => {
      let entry = toolTraceMessageEntriesRef.current.find(
        (item) => item.key === traceOptions.key,
      );
      if (!entry) {
        entry = {
          key: traceOptions.key,
          id: `tool-trace-${Date.now()}-${toolTraceSequenceRef.current}`,
          args: traceOptions.args,
        };
        toolTraceSequenceRef.current += 1;
        toolTraceMessageEntriesRef.current = [
          ...toolTraceMessageEntriesRef.current,
          entry,
        ];
      } else if (traceOptions.args !== undefined) {
        entry.args = traceOptions.args;
      }

      const accountId =
        options.sessions.find((session) => session.id === sessionId)
          ?.account_id ?? 'web';

      setMessages((previous) => {
        const existingIndex = previous.findIndex(
          (message) => message.id === entry.id,
        );
        const nextMessage: Message = {
          id: entry.id,
          account_id: accountId,
          sender: '',
          sender_name: '',
          content,
          timestamp: new Date().toISOString(),
          is_from_me: true,
          is_bot_message: true,
          metadata: {
            kind: 'tool_trace',
            stage: `tool_${traceOptions.status}`,
            workflow: 'pi_runtime',
            tool_call_id: traceOptions.key,
            tool_name: traceOptions.toolName,
            tool_label: getToolLabel(traceOptions.toolName),
            tool_status: traceOptions.status,
            tool_path: traceOptions.path,
          },
        };

        if (existingIndex >= 0) {
          const next = [...previous];
          next[existingIndex] = nextMessage;
          return next;
        }

        return [...previous, nextMessage];
      });
    },
    [options.sessions],
  );

  useEffect(() => {
    streamSocketRef.current?.close();
    streamSocketRef.current = null;
    resetStreamingMessageRefs();

    const sessionId = options.selectedSession;
    if (!sessionId || typeof window === 'undefined') return;

    const token = localStorage.getItem('token');
    if (!token) return;

    let closedByEffect = false;
    let socket: WebSocket | null = null;

    try {
      socket = new WebSocket(buildChatSessionStreamUrl(sessionId, token));
      streamSocketRef.current = socket;
    } catch {
      return;
    }

    socket.onmessage = (event) => {
      if (activeSessionRef.current !== sessionId) return;
      let payload: ChatSessionStreamEvent;
      try {
        payload = JSON.parse(event.data) as ChatSessionStreamEvent;
      } catch {
        return;
      }

      if (payload.type === 'turn_start') {
        beginStreamingAssistantTurn(payload.turnIndex);
        setProcessing(true);
        return;
      }

      if (payload.type === 'agent_start') {
        setProcessing(true);
        return;
      }

      if (payload.type === 'agent_end') {
        return;
      }

      if (payload.type === 'assistant_delta') {
        upsertStreamingAssistantMessage(
          sessionId,
          payload.snapshot,
          typeof payload.turnIndex === 'number'
            ? `turn-${payload.turnIndex}`
            : latestStreamingMessageKeyRef.current,
        );
        setProcessing(true);
        return;
      }

      if (payload.type === 'thinking_delta') {
        upsertThinkingMessage(
          sessionId,
          payload.snapshot,
          typeof payload.turnIndex === 'number' ? payload.turnIndex : undefined,
        );
        setProcessing(true);
        return;
      }

      if (payload.type === 'assistant_message' && payload.text.trim()) {
        upsertStreamingAssistantMessage(
          sessionId,
          payload.text,
          typeof payload.turnIndex === 'number'
            ? `turn-${payload.turnIndex}`
            : latestStreamingMessageKeyRef.current,
        );
        return;
      }

      if (payload.type === 'progress') {
        const metadata =
          payload.metadata &&
          typeof payload.metadata === 'object' &&
          !Array.isArray(payload.metadata)
            ? (payload.metadata as Record<string, unknown>)
            : null;
        if (metadata?.kind === 'tool_trace') {
          const toolCallId =
            typeof metadata.tool_call_id === 'string'
              ? metadata.tool_call_id
              : `progress-${payload.timestamp ?? Date.now()}`;
          const toolName =
            typeof metadata.tool_name === 'string'
              ? metadata.tool_name
              : 'tool';
          const status =
            metadata.tool_status === 'completed' ||
            metadata.tool_status === 'failed' ||
            metadata.tool_status === 'running'
              ? metadata.tool_status
              : 'running';
          upsertToolTraceMessage(sessionId, payload.text, {
            key: toolCallId,
            toolName,
            status,
            path:
              typeof metadata.tool_path === 'string'
                ? sanitizeToolPath(metadata.tool_path)
                : undefined,
          });
          setProcessing(true);
          return;
        }
        setProcessing(true);
        return;
      }

      if (payload.type === 'tool_start') {
        const path = readToolPath(payload.args);
        upsertToolTraceMessage(
          sessionId,
          buildToolTraceContent({
            toolName: payload.toolName,
            status: 'running',
            path,
          }),
          {
            key: payload.toolCallId,
            toolName: payload.toolName,
            status: 'running',
            path,
            args: payload.args,
          },
        );
        setProcessing(true);
        return;
      }

      if (payload.type === 'tool_update') {
        const path = readToolPath(payload.args);
        upsertToolTraceMessage(
          sessionId,
          buildToolTraceContent({
            toolName: payload.toolName,
            status: 'running',
            path,
          }),
          {
            key: payload.toolCallId,
            toolName: payload.toolName,
            status: 'running',
            path,
            args: payload.args,
          },
        );
        setProcessing(true);
        return;
      }

      if (payload.type === 'tool_end') {
        const existing = toolTraceMessageEntriesRef.current.find(
          (entry) => entry.key === payload.toolCallId,
        );
        const path = readToolPath(existing?.args);
        const status = payload.isError ? 'failed' : 'completed';
        upsertToolTraceMessage(
          sessionId,
          buildToolTraceContent({
            toolName: payload.toolName,
            status,
            path,
          }),
          {
            key: payload.toolCallId,
            toolName: payload.toolName,
            status,
            path,
          },
        );
        setProcessing(true);
        return;
      }

      if (payload.type === 'final') {
        if (payload.text.trim()) {
          upsertLatestStreamingAssistantMessage(sessionId, payload.text);
        }
        setProcessing(false);
        setAwaitingRefresh(true);
        void loadMessages(sessionId, { background: true });
        return;
      }

      if (payload.type === 'error') {
        const activeStreamingMessageIds = getActiveStreamingMessageIds();
        resetStreamingMessageRefs();
        if (activeStreamingMessageIds.length > 0) {
          const activeStreamingMessageIdSet = new Set(activeStreamingMessageIds);
          setMessages((previous) =>
            previous.filter(
              (message) => !activeStreamingMessageIdSet.has(message.id),
            ),
          );
        }
        setProcessing(false);
        setAwaitingRefresh(false);
      }
    };

    socket.onerror = () => {
      if (activeSessionRef.current === sessionId) {
        setAwaitingRefresh(true);
      }
    };

    socket.onclose = () => {
      if (!closedByEffect && activeSessionRef.current === sessionId) {
        streamSocketRef.current = null;
      }
    };

    return () => {
      closedByEffect = true;
      socket?.close();
      if (streamSocketRef.current === socket) {
        streamSocketRef.current = null;
      }
      resetStreamingMessageRefs();
    };
  }, [
    beginStreamingAssistantTurn,
    getActiveStreamingMessageIds,
    loadMessages,
    options.selectedSession,
    resetStreamingMessageRefs,
    upsertLatestStreamingAssistantMessage,
    upsertStreamingAssistantMessage,
    upsertThinkingMessage,
    upsertToolTraceMessage,
  ]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const handleScroll = () => {
      shouldAutoScrollRef.current = isNearBottom(element);
    };

    handleScroll();
    element.addEventListener('scroll', handleScroll);

    return () => {
      element.removeEventListener('scroll', handleScroll);
    };
  }, []);

  useLayoutEffect(() => {
    if (!scrollRef.current || !shouldAutoScrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (!isPending || !scrollRef.current || !shouldAutoScrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [isPending]);

  const sendMessageWithOptions = useCallback(
    async (
      text: string,
      sendOptions?: ChatMessageSendOptions,
    ) => {
      const content = text.trim();
      if (!content || isPending) return false;
      if (!options.selectedSession && !options.chatAvailable) return false;

      setSending(true);
      shouldAutoScrollRef.current = true;

      try {
        let sessionId = options.selectedSession;

        if (!sessionId) {
          if (creatingRef.current) return false;

          creatingRef.current = true;

          try {
            const newSession = await options.createSession();
            if (!newSession) return false;

            sessionId = newSession.id;
            setMessages([]);
            shouldAutoScrollRef.current = true;
          } finally {
            creatingRef.current = false;
          }
        }

        const optimisticUser: Message = {
          id: `opt-user-${Date.now()}`,
          account_id:
            options.sessions.find((session) => session.id === sessionId)
              ?.account_id ?? 'web',
          sender: '',
          sender_name: '',
          content,
          timestamp: new Date().toISOString(),
          is_from_me: false,
          is_bot_message: false,
        };

        setMessages((previous) => [...previous, optimisticUser]);

        try {
          const { text: replyText, session_title: sessionTitle } =
            await sendChatSessionMessageWithOptions(
              chatSessionsApi.send,
              sessionId,
              content,
              sendOptions,
            );

          const refreshed = await loadMessages(sessionId, { background: true });
          if (!refreshed) {
            setAwaitingRefresh(true);
            setMessages((previous) => [
              ...previous,
              {
                id: `opt-bot-${Date.now()}`,
                account_id:
                  options.sessions.find((session) => session.id === sessionId)
                    ?.account_id ?? 'web',
                sender: '',
                sender_name: '',
                content: replyText,
                timestamp: new Date().toISOString(),
                is_from_me: true,
                is_bot_message: true,
              },
            ]);
          }

          const currentSession = options.sessions.find(
            (session) => session.id === sessionId,
          );
          options.touchSession(sessionId, {
            updated_at: new Date().toISOString(),
            title:
              sessionTitle ||
              currentSession?.title ||
              DEFAULT_AI_CHAT_SESSION_TITLE,
          });
          return true;
        } catch (error) {
          const errorMessage =
            error instanceof Error
              ? error.message
              : '抱歉，AI 服务暂时不可用，请稍后重试';
          setMessages((previous) => [
            ...previous,
            {
              id: `opt-error-${Date.now()}`,
              account_id:
                options.sessions.find((session) => session.id === sessionId)
                  ?.account_id ?? 'web',
              sender: '',
              sender_name: '',
              content: errorMessage,
              timestamp: new Date().toISOString(),
              is_from_me: true,
              is_bot_message: true,
            },
          ]);
          return false;
        }
      } finally {
        setSending(false);
        inputRef.current?.focus();
      }
    },
    [isPending, loadMessages, options],
  );

  const sendMessage = useCallback(
    async (text: string) => sendMessageWithOptions(text),
    [sendMessageWithOptions],
  );

  const refreshMessages = useCallback(async () => {
    if (!options.selectedSession) {
      return;
    }
    await loadMessages(options.selectedSession, { background: false });
  }, [loadMessages, options.selectedSession]);

  return {
    messages,
    loading,
    sending: isPending,
    scrollRef,
    inputRef,
    sendMessage,
    sendMessageWithOptions,
    refreshMessages,
  };
}
