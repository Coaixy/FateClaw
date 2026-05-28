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

const DEFAULT_AI_CHAT_SESSION_TITLE = '未设置标题';
const CHAT_POLL_INTERVAL_MS = 1200;

export type ChatMessageSendOptions = ChatSessionSendOptions;

type ChatSessionSender = typeof chatSessionsApi.send;

function appendActiveStreamingMessage(
  nextMessages: Message[],
  previousMessages: Message[],
  activeStreamingMessageId: string | null,
) {
  if (
    !activeStreamingMessageId ||
    nextMessages.some((message) => message.id === activeStreamingMessageId)
  ) {
    return nextMessages;
  }

  const streamingMessage = previousMessages.find(
    (message) => message.id === activeStreamingMessageId,
  );
  return streamingMessage ? [...nextMessages, streamingMessage] : nextMessages;
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
  const streamingMessageIdRef = useRef<string | null>(null);
  const isPending = sending || processing || awaitingRefresh;

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
        const activeStreamingMessageId = streamingMessageIdRef.current;
        const streamingResolved =
          isBackground &&
          Boolean(activeStreamingMessageId) &&
          hasFinalAssistantAfterLatestUser(nextMessages);
        if (
          streamingResolved &&
          streamingMessageIdRef.current === activeStreamingMessageId
        ) {
          streamingMessageIdRef.current = null;
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
                  activeStreamingMessageId,
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
            Boolean(activeStreamingMessageId) &&
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
    [],
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
    (sessionId: string, content: string) => {
      const existingId = streamingMessageIdRef.current;
      const accountId =
        options.sessions.find((session) => session.id === sessionId)
          ?.account_id ?? 'web';

      setMessages((previous) => {
        if (existingId) {
          const existingIndex = previous.findIndex(
            (message) => message.id === existingId,
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
        }

        const id = `stream-bot-${Date.now()}`;
        streamingMessageIdRef.current = id;
        return [
          ...previous,
          {
            id,
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

  useEffect(() => {
    streamSocketRef.current?.close();
    streamSocketRef.current = null;
    streamingMessageIdRef.current = null;

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

      if (payload.type === 'assistant_delta') {
        upsertStreamingAssistantMessage(sessionId, payload.snapshot);
        setProcessing(true);
        return;
      }

      if (payload.type === 'assistant_message' && payload.text.trim()) {
        upsertStreamingAssistantMessage(sessionId, payload.text);
        return;
      }

      if (payload.type === 'progress') {
        setProcessing(true);
        return;
      }

      if (payload.type === 'final') {
        if (payload.text.trim()) {
          upsertStreamingAssistantMessage(sessionId, payload.text);
        }
        setProcessing(false);
        setAwaitingRefresh(true);
        void loadMessages(sessionId, { background: true });
        return;
      }

      if (payload.type === 'error') {
        const activeStreamingMessageId = streamingMessageIdRef.current;
        streamingMessageIdRef.current = null;
        if (activeStreamingMessageId) {
          setMessages((previous) =>
            previous.filter(
              (message) => message.id !== activeStreamingMessageId,
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
      streamingMessageIdRef.current = null;
    };
  }, [
    loadMessages,
    options.selectedSession,
    upsertStreamingAssistantMessage,
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
