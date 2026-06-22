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
  type ChatSessionRequestOptions,
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
const CHAT_STREAM_RECONNECT_INITIAL_DELAY_MS = 500;
const CHAT_STREAM_RECONNECT_MAX_DELAY_MS = 8000;
const CHAT_STREAM_RECONNECT_MAX_ATTEMPTS = 6;
const DEFAULT_AI_CHAT_ERROR_MESSAGE = '抱歉，AI 服务暂时不可用，请稍后重试';
const GENERIC_REQUEST_FAILED_MESSAGE = '请求失败，请检查后重试';
const AI_CHAT_RECONNECTING_MESSAGE = '请求断开，正在重连';
// 流式静默看门狗:对话进入 pending(显示"AI正在回复")后,若连续 STUCK 毫秒既没有任何
// WebSocket 流事件、也没有新消息落库,判定后端可能已挂死且终止事件丢失。此时前端不再
// 无限转圈——主动取消(经 cancel 接口权威释放后端会话锁,保证可立即重试)并提示用户。
// 详见对话偶发卡死排查:后端兜底要等 30~35 分钟,看门狗把用户感知恢复缩短到秒级。
const CHAT_STUCK_TIMEOUT_MS = 90_000;
const CHAT_STUCK_CHECK_INTERVAL_MS = 5_000;
const CHAT_STUCK_MESSAGE = '这次回复似乎中断了，请重试';

export type ChatMessageSendOptions = ChatSessionSendOptions;

type ChatSessionSender = typeof chatSessionsApi.send;
type ChatSessionSendRequestOptions = Pick<ChatSessionRequestOptions, 'signal'>;
type LoadMessagesResult =
  | {
      ok: true;
      active: true;
      messages: Message[];
      processing: boolean;
    }
  | {
      ok: true;
      active: false;
    }
  | {
      ok: false;
    };

/**
 * 判断发送阶段的异常是否可能只是浏览器和 API 的连接中断。
 *
 * 这类异常不代表后端没有收到消息：长回复期间连接断开时，后端可能仍在继续生成。
 * 因此前端应进入同步状态，而不是马上落一个“失败”气泡误导用户重复发送。
 */
export function isRecoverableChatSendInterruption(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const status = (error as { status?: unknown }).status;
  return status === 0;
}

/**
 * 计算 AI Chat 实时流断线后的退避重连间隔。
 *
 * @param attempt 从 0 开始的重连次数。
 * @returns 经过上限裁剪后的毫秒延迟。
 */
export function getAiChatStreamReconnectDelay(attempt: number): number {
  const normalizedAttempt = Math.max(0, Math.floor(attempt));
  return Math.min(
    CHAT_STREAM_RECONNECT_INITIAL_DELAY_MS * 2 ** normalizedAttempt,
    CHAT_STREAM_RECONNECT_MAX_DELAY_MS,
  );
}

/**
 * 从 AI Chat 流式错误事件中取出最终展示给用户的错误文案。
 *
 * @param event WebSocket 推送的错误事件，优先使用后端净化后的 publicErrorText。
 * @returns 非空错误文案；事件没有可用内容时返回通用 AI 服务错误。
 */
export function getAiChatStreamErrorMessage(
  event: Pick<
    Extract<ChatSessionStreamEvent, { type: 'error' }>,
    'publicErrorText' | 'error'
  >,
): string {
  const publicErrorText = event.publicErrorText?.trim();
  if (publicErrorText) return publicErrorText;

  const rawError = event.error?.trim();
  return rawError || DEFAULT_AI_CHAT_ERROR_MESSAGE;
}

/**
 * 归一化 AI Chat 发送阶段的错误文案。
 *
 * @param error 捕获到的发送异常。
 * @returns 适合展示在聊天界面的错误或重连提示。
 */
export function getAiChatSendErrorMessage(error: unknown): string {
  const status =
    error instanceof Error ? (error as { status?: unknown }).status : null;
  if (status === 410) {
    return DEFAULT_AI_CHAT_ERROR_MESSAGE;
  }

  const message =
    error instanceof Error
      ? error.message.trim()
      : DEFAULT_AI_CHAT_ERROR_MESSAGE;
  if (
    !message ||
    message === GENERIC_REQUEST_FAILED_MESSAGE ||
    message.startsWith('网络连接失败')
  ) {
    return AI_CHAT_RECONNECTING_MESSAGE;
  }
  return message;
}

function isReconnectNoticeMessage(message: Message) {
  return (
    Boolean(message.is_bot_message) && message.metadata?.kind === 'reconnecting'
  );
}

function withoutReconnectNoticeMessages(messages: Message[]) {
  return messages.filter((message) => !isReconnectNoticeMessage(message));
}

function appendTransientAssistantMessages(
  nextMessages: Message[],
  previousMessages: Message[],
  activeStreamingMessageIds: string[],
) {
  const existingIds = new Set(nextMessages.map((message) => message.id));
  const streamingMessages = activeStreamingMessageIds.flatMap((id) => {
    if (existingIds.has(id)) return [];
    const streamingMessage = previousMessages.find(
      (message) => message.id === id,
    );
    return streamingMessage ? [streamingMessage] : [];
  });
  const streamingMessageIds = new Set(
    streamingMessages.map((message) => message.id),
  );
  const shouldPreserveLocalErrors =
    !hasFinalAssistantAfterLatestUser(nextMessages);
  let latestUserIndex = -1;

  for (let index = previousMessages.length - 1; index >= 0; index -= 1) {
    if (!previousMessages[index].is_bot_message) {
      latestUserIndex = index;
      break;
    }
  }

  // 后台刷新可能早于 HTTP 失败响应返回，需保留本地错误气泡避免界面短暂或永久空白。
  const localErrorMessages = shouldPreserveLocalErrors
    ? previousMessages.slice(latestUserIndex + 1).filter((message) => {
        return (
          Boolean(message.is_bot_message) &&
          message.metadata?.kind === 'error' &&
          !existingIds.has(message.id) &&
          !streamingMessageIds.has(message.id)
        );
      })
    : [];
  const transientMessages = [...streamingMessages, ...localErrorMessages];

  return transientMessages.length > 0
    ? [...nextMessages, ...transientMessages]
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

function normalizeMessageMetadata(value: unknown): Message['metadata'] {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Message['metadata'])
    : null;
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
  requestOptions?: ChatSessionSendRequestOptions,
) {
  if (requestOptions) {
    return sender(sessionId, content, sendOptions, requestOptions);
  }
  return sender(sessionId, content, sendOptions);
}

export function useChatMessages(options: {
  chatAvailable: boolean;
  selectedSession: string;
  selectedSessionRevision: number;
  sessions: ChatSession[];
  createSession: () => Promise<ChatSession | null>;
  touchSession: (sessionId: string, patch: Partial<ChatSession>) => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [awaitingRefresh, setAwaitingRefresh] = useState(false);
  const [loadedSessionId, setLoadedSessionId] = useState('');
  const [continuationBlocked, setContinuationBlocked] = useState(false);
  const [continuationBlockMessage, setContinuationBlockMessage] = useState('');
  const [streamReconnectNonce, setStreamReconnectNonce] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pollInFlightRef = useRef(false);
  const sendingRef = useRef(false);
  const processingRef = useRef(false);
  const awaitingRefreshRef = useRef(false);
  const databaseProcessingRef = useRef(false);
  const activeSessionRef = useRef('');
  const previousSelectedSessionRef = useRef('');
  const shouldAutoScrollRef = useRef(true);
  const creatingRef = useRef(false);
  const streamSocketRef = useRef<WebSocket | null>(null);
  const sendAbortControllerRef = useRef<AbortController | null>(null);
  const interruptedStreamSessionRef = useRef<string | null>(null);
  const streamingMessageEntriesRef = useRef<Array<{ key: string; id: string }>>(
    [],
  );
  const toolTraceMessageEntriesRef = useRef<
    Array<{ key: string; id: string; args?: unknown }>
  >([]);
  const latestStreamingMessageKeyRef = useRef<string | null>(null);
  const latestThinkingMessageKeyRef = useRef<string | null>(null);
  const streamingSequenceRef = useRef(0);
  const toolTraceSequenceRef = useRef(0);
  const localMessageSequenceRef = useRef(0);
  // 最近一次"流仍在推进"的时间戳:WS 流事件或新消息落库都会刷新它,看门狗据此判定静默卡死。
  const lastStreamActivityRef = useRef(0);
  // 最近一次已知的服务端消息条数,用于在轮询中识别"有新消息落库"=本轮仍在推进。
  const lastSeenMessageCountRef = useRef(0);
  const isPending = sending || processing || awaitingRefresh;
  const activeContinuationBlocked = Boolean(
    options.selectedSession &&
      loadedSessionId === options.selectedSession &&
      continuationBlocked,
  );

  const isStreamInterrupted = useCallback(
    (sessionId: string) => interruptedStreamSessionRef.current === sessionId,
    [],
  );

  const getActiveStreamingMessageIds = useCallback(
    () => streamingMessageEntriesRef.current.map((entry) => entry.id),
    [],
  );

  const resetStreamingMessageRefs = useCallback(() => {
    streamingMessageEntriesRef.current = [];
    latestStreamingMessageKeyRef.current = null;
    latestThinkingMessageKeyRef.current = null;
    toolTraceMessageEntriesRef.current = [];
  }, []);

  const beginStreamingAssistantTurn = useCallback((turnIndex?: number) => {
    const key =
      typeof turnIndex === 'number'
        ? `turn-${turnIndex}`
        : `turn-${streamingSequenceRef.current}`;
    latestStreamingMessageKeyRef.current = key;
    latestThinkingMessageKeyRef.current = `thinking-${key}`;
    return key;
  }, []);

  const updateAwaitingRefresh = useCallback((next: boolean) => {
    awaitingRefreshRef.current = next;
    setAwaitingRefresh(next);
  }, []);

  const updateProcessing = useCallback((next: boolean) => {
    processingRef.current = next;
    setProcessing(next);
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
    async (
      sessionId: string,
      loadOptions?: { background?: boolean },
    ): Promise<LoadMessagesResult> => {
      if (!sessionId) return { ok: false };

      const isBackground = loadOptions?.background ?? false;
      if (!isBackground) {
        setLoading(true);
      }

      try {
        const data = await chatSessionsApi.messages(sessionId);
        if (activeSessionRef.current !== sessionId) {
          return { ok: true, active: false };
        }

        setLoadedSessionId(sessionId);
        setContinuationBlocked(Boolean(data.continuation_blocked));
        setContinuationBlockMessage(data.continuation_block_message || '');
        databaseProcessingRef.current = data.processing;

        const nextMessages = data.messages.reverse();
        if (nextMessages.length !== lastSeenMessageCountRef.current) {
          // 有新消息落库,说明本轮仍在推进,刷新看门狗静默窗口
          lastSeenMessageCountRef.current = nextMessages.length;
          lastStreamActivityRef.current = Date.now();
        }
        if (isBackground && isStreamInterrupted(sessionId)) {
          databaseProcessingRef.current = false;
          return {
            ok: true,
            active: true,
            messages: nextMessages,
            processing: false,
          };
        }
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
              ? appendTransientAssistantMessages(
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
        updateProcessing(data.processing);
        updateAwaitingRefresh(
          isBackground && data.processing,
        );
        return {
          ok: true,
          active: true,
          messages: nextMessages,
          processing: data.processing,
        };
      } catch (error) {
        if (activeSessionRef.current === sessionId && !isBackground) {
          const content =
            error instanceof Error
              ? `加载历史消息失败：${error.message}`
              : '加载历史消息失败，请稍后重试';
          const messageId = `opt-load-error-${Date.now()}-${localMessageSequenceRef.current}`;
          localMessageSequenceRef.current += 1;
          setMessages([
            {
              id: messageId,
              account_id: 'web',
              sender: '',
              sender_name: '',
              content,
              timestamp: new Date().toISOString(),
              is_from_me: true,
              is_bot_message: true,
              metadata: {
                kind: 'error',
                turn_complete: true,
              },
            },
          ]);
        }
        return { ok: false };
      } finally {
        if (activeSessionRef.current === sessionId && !isBackground) {
          setLoading(false);
        }
      }
    },
    [
      getActiveStreamingMessageIds,
      isStreamInterrupted,
      resetStreamingMessageRefs,
      updateAwaitingRefresh,
      updateProcessing,
    ],
  );

  useEffect(() => {
    const previousSelectedSession = previousSelectedSessionRef.current;
    previousSelectedSessionRef.current = options.selectedSession;

    if (options.selectedSession) {
      updateProcessing(false);
      updateAwaitingRefresh(false);
      databaseProcessingRef.current = false;
      setLoadedSessionId('');
      setContinuationBlocked(false);
      setContinuationBlockMessage('');
      void loadMessages(options.selectedSession, {
        background:
          sendingRef.current &&
          previousSelectedSession === options.selectedSession,
      });
      return;
    }

    setLoading(false);
    setMessages([]);
    setSending(false);
    updateProcessing(false);
    updateAwaitingRefresh(false);
    databaseProcessingRef.current = false;
    setLoadedSessionId('');
    setContinuationBlocked(false);
    setContinuationBlockMessage('');
  }, [
    loadMessages,
    options.selectedSession,
    options.selectedSessionRevision,
    updateAwaitingRefresh,
    updateProcessing,
  ]);

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
    (
      sessionId: string,
      content: string,
      streamKey?: string | null,
      metadata?: Message['metadata'],
      streamOptions?: { updateLatestKey?: boolean },
    ) => {
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
      if (streamOptions?.updateLatestKey !== false) {
        latestStreamingMessageKeyRef.current = key;
      }
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
            metadata: metadata ?? {
              kind: 'streaming',
            },
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
            metadata: metadata ?? {
              kind: 'streaming',
            },
          },
        ];
      });
    },
    [options.sessions],
  );

  const upsertLatestStreamingAssistantMessage = useCallback(
    (sessionId: string, content: string, metadata?: Message['metadata']) => {
      upsertStreamingAssistantMessage(
        sessionId,
        content,
        latestStreamingMessageKeyRef.current,
        metadata,
      );
    },
    [upsertStreamingAssistantMessage],
  );

  const upsertThinkingMessage = useCallback(
    (sessionId: string, content: string, turnIndex?: number) => {
      const text = content.trim();
      if (!text) return;
      const baseKey =
        typeof turnIndex === 'number'
          ? `turn-${turnIndex}`
          : latestStreamingMessageKeyRef.current ??
            `turn-${streamingSequenceRef.current}`;
      const key =
        typeof turnIndex === 'number'
          ? `thinking-${baseKey}`
          : latestThinkingMessageKeyRef.current ?? `thinking-${baseKey}`;
      latestThinkingMessageKeyRef.current = key;

      upsertStreamingAssistantMessage(
        sessionId,
        text,
        key,
        {
          kind: 'thinking',
          stage: 'thinking',
          workflow: 'pi_runtime',
        },
        { updateLatestKey: false },
      );
    },
    [upsertStreamingAssistantMessage],
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

  const finalizeRunningToolTraceMessages = useCallback(
    (status: 'completed' | 'failed') => {
      setMessages((previous) => {
        let changed = false;
        const next = previous.map((message) => {
          const metadata =
            message.metadata &&
            typeof message.metadata === 'object' &&
            !Array.isArray(message.metadata)
              ? (message.metadata as Record<string, unknown>)
              : null;
          if (
            !metadata ||
            metadata.kind !== 'tool_trace' ||
            metadata.tool_status !== 'running'
          ) {
            return message;
          }

          const toolName =
            typeof metadata.tool_name === 'string'
              ? metadata.tool_name
              : typeof metadata.tool_label === 'string'
                ? metadata.tool_label
                : 'tool';
          const path =
            typeof metadata.tool_path === 'string'
              ? sanitizeToolPath(metadata.tool_path)
              : undefined;
          changed = true;

          return {
            ...message,
            content: buildToolTraceContent({
              toolName,
              status,
              path,
            }),
            metadata: {
              ...metadata,
              stage: `tool_${status}`,
              tool_status: status,
              tool_path: path,
            },
          };
        });

        return changed ? next : previous;
      });
    },
    [],
  );

  const appendAssistantErrorMessage = useCallback(
    (
      sessionId: string,
      content: string,
      appendOptions?: { removeMessageIds?: string[] },
    ) => {
      const accountId =
        options.sessions.find((session) => session.id === sessionId)
          ?.account_id ?? 'web';
      const messageId = `opt-error-${Date.now()}-${localMessageSequenceRef.current}`;
      localMessageSequenceRef.current += 1;
      const removeMessageIdSet = new Set(appendOptions?.removeMessageIds ?? []);

      setMessages((previous) => {
        const visibleMessages =
          removeMessageIdSet.size > 0
            ? previous.filter((message) => !removeMessageIdSet.has(message.id))
            : previous;
        const latestMessage = visibleMessages[visibleMessages.length - 1];

        if (
          latestMessage?.is_bot_message &&
          latestMessage.metadata?.kind === 'error' &&
          latestMessage.content === content
        ) {
          return visibleMessages.length === previous.length
            ? previous
            : visibleMessages;
        }

        return [
          ...visibleMessages,
          {
            id: messageId,
            account_id: accountId,
            sender: '',
            sender_name: '',
            content,
            timestamp: new Date().toISOString(),
            is_from_me: true,
            is_bot_message: true,
            metadata: {
              kind: 'error',
              turn_complete: true,
            },
          },
        ];
      });
    },
    [options.sessions],
  );

  const appendReconnectNoticeMessage = useCallback(
    (sessionId: string) => {
      const accountId =
        options.sessions.find((session) => session.id === sessionId)
          ?.account_id ?? 'web';
      const messageId = `opt-reconnect-${Date.now()}-${localMessageSequenceRef.current}`;
      localMessageSequenceRef.current += 1;

      setMessages((previous) => {
        const visibleMessages = withoutReconnectNoticeMessages(previous);
        return [
          ...visibleMessages,
          {
            id: messageId,
            account_id: accountId,
            sender: '',
            sender_name: '',
            content: AI_CHAT_RECONNECTING_MESSAGE,
            timestamp: new Date().toISOString(),
            is_from_me: true,
            is_bot_message: true,
            metadata: {
              kind: 'reconnecting',
            },
          },
        ];
      });
    },
    [options.sessions],
  );

  // 看门狗判定卡死后的收尾:与 stopGenerating 同一套释放逻辑,额外追加一条错误提示。
  const handleStuckTurn = useCallback(
    (sessionId: string) => {
      // 后端会话可能已挂死且终止事件丢失:必须主动取消以权威释放后端会话锁,否则用户
      // 重试会撞 409"会话正在处理其他请求"。随后关闭当前流、清空本地 pending 状态。
      interruptedStreamSessionRef.current = sessionId;
      void chatSessionsApi.cancel(sessionId).catch(() => undefined);
      sendAbortControllerRef.current?.abort();
      const socket = streamSocketRef.current;
      if (socket) {
        streamSocketRef.current = null;
        socket.close();
      }
      const activeStreamingMessageIds = getActiveStreamingMessageIds();
      databaseProcessingRef.current = false;
      finalizeRunningToolTraceMessages('failed');
      resetStreamingMessageRefs();
      setSending(false);
      updateProcessing(false);
      updateAwaitingRefresh(false);
      appendAssistantErrorMessage(sessionId, CHAT_STUCK_MESSAGE, {
        removeMessageIds: activeStreamingMessageIds,
      });
    },
    [
      appendAssistantErrorMessage,
      finalizeRunningToolTraceMessages,
      getActiveStreamingMessageIds,
      resetStreamingMessageRefs,
      updateAwaitingRefresh,
      updateProcessing,
    ],
  );

  // 用 ref 持有最新 handleStuckTurn:它依赖 sessions,若直接进 effect 依赖会随 sessions
  // 频繁变化导致看门狗 effect 重建、不断刷新静默窗口而永远触发不了。
  const handleStuckTurnRef = useRef(handleStuckTurn);
  useEffect(() => {
    handleStuckTurnRef.current = handleStuckTurn;
  }, [handleStuckTurn]);

  // 流式静默看门狗:仅在 pending 期间运行(isPending 持续为 true 时 effect 不重建,
  // 故静默窗口只由真实流事件/新消息刷新),静默超过阈值则判定卡死并收尾。
  useEffect(() => {
    if (!options.selectedSession || !isPending) return;
    // 进入 pending 时刷新窗口,避免页面刚加载/切回会话时带着陈旧时间戳被立即误判。
    lastStreamActivityRef.current = Date.now();
    const timerId = window.setInterval(() => {
      const stillPending =
        sendingRef.current ||
        processingRef.current ||
        awaitingRefreshRef.current;
      if (
        !stillPending ||
        activeSessionRef.current !== options.selectedSession ||
        document.visibilityState === 'hidden' // 后台标签页不计时,回到前台再判
      ) {
        return;
      }
      if (Date.now() - lastStreamActivityRef.current < CHAT_STUCK_TIMEOUT_MS) {
        return;
      }
      handleStuckTurnRef.current(options.selectedSession);
    }, CHAT_STUCK_CHECK_INTERVAL_MS);
    return () => window.clearInterval(timerId);
  }, [isPending, options.selectedSession]);

  useEffect(() => {
    streamSocketRef.current?.close();
    streamSocketRef.current = null;
    resetStreamingMessageRefs();

    const sessionId = options.selectedSession;
    if (!sessionId || typeof window === 'undefined') return;

    let closedByEffect = false;
    let socket: WebSocket | null = null;
    let reconnectTimeoutId: number | null = null;
    let reconnectAttempt = 0;

    // 流式增量按帧合并:assistant/thinking 的 delta 携带的是累积全量快照,合并到"最新一帧"
    // 不丢任何字;每帧最多 setState 一次,避免长回复时每个 token 都重解析整条 markdown。
    let streamFlushFrame: number | null = null;
    let pendingAssistant: { snapshot: string; key: string | null } | null = null;
    let pendingThinking: { snapshot: string; turnIndex?: number } | null = null;
    const flushStreamDeltas = () => {
      streamFlushFrame = null;
      if (pendingThinking) {
        const next = pendingThinking;
        pendingThinking = null;
        upsertThinkingMessage(sessionId, next.snapshot, next.turnIndex);
      }
      if (pendingAssistant) {
        const next = pendingAssistant;
        pendingAssistant = null;
        upsertStreamingAssistantMessage(sessionId, next.snapshot, next.key);
      }
    };
    const scheduleStreamFlush = () => {
      if (streamFlushFrame === null) {
        streamFlushFrame = window.requestAnimationFrame(flushStreamDeltas);
      }
    };
    const cancelStreamFlush = () => {
      if (streamFlushFrame !== null) {
        window.cancelAnimationFrame(streamFlushFrame);
        streamFlushFrame = null;
      }
    };

    const clearReconnectTimeout = () => {
      if (reconnectTimeoutId === null) return;
      window.clearTimeout(reconnectTimeoutId);
      reconnectTimeoutId = null;
    };

    const hasRecoverableStreamActivity = () =>
      !isStreamInterrupted(sessionId) &&
      (sendingRef.current ||
        databaseProcessingRef.current ||
        awaitingRefreshRef.current);

    const scheduleReconnect = () => {
      if (
        closedByEffect ||
        activeSessionRef.current !== sessionId ||
        isStreamInterrupted(sessionId)
      ) {
        return;
      }
      if (reconnectAttempt >= CHAT_STREAM_RECONNECT_MAX_ATTEMPTS) {
        return;
      }

      const delay = getAiChatStreamReconnectDelay(reconnectAttempt);
      reconnectAttempt += 1;
      clearReconnectTimeout();
      reconnectTimeoutId = window.setTimeout(() => {
        reconnectTimeoutId = null;
        connectStream();
      }, delay);
    };

    const handleStreamMessage = (event: MessageEvent) => {
      if (
        activeSessionRef.current !== sessionId ||
        isStreamInterrupted(sessionId)
      )
        return;
      let payload: ChatSessionStreamEvent;
      try {
        payload = JSON.parse(event.data) as ChatSessionStreamEvent;
      } catch {
        return;
      }
      // 收到任何有效流事件 = 后端仍在推进,刷新看门狗静默窗口
      lastStreamActivityRef.current = Date.now();

      // 非增量事件(最终态/工具轨迹/错误等)依赖最新流式文本且要保持插入顺序:
      // 先把 pending 的增量同步刷出,再处理本事件。
      if (
        payload.type !== 'assistant_delta' &&
        payload.type !== 'thinking_delta'
      ) {
        cancelStreamFlush();
        flushStreamDeltas();
      }

      if (payload.type === 'connected') {
        reconnectAttempt = 0;
        setMessages((previous) => withoutReconnectNoticeMessages(previous));
        return;
      }

      if (payload.type === 'turn_start') {
        beginStreamingAssistantTurn(payload.turnIndex);
        updateProcessing(true);
        return;
      }

      if (payload.type === 'agent_start') {
        updateProcessing(true);
        return;
      }

      if (payload.type === 'agent_end') {
        return;
      }

      if (payload.type === 'assistant_delta') {
        // 合并到最新快照,按帧 flush(见上方 scheduleStreamFlush)
        pendingAssistant = {
          snapshot: payload.snapshot,
          key:
            typeof payload.turnIndex === 'number'
              ? `turn-${payload.turnIndex}`
              : latestStreamingMessageKeyRef.current,
        };
        updateProcessing(true);
        scheduleStreamFlush();
        return;
      }

      if (payload.type === 'thinking_delta') {
        pendingThinking = {
          snapshot: payload.snapshot,
          turnIndex:
            typeof payload.turnIndex === 'number'
              ? payload.turnIndex
              : undefined,
        };
        updateProcessing(true);
        scheduleStreamFlush();
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
          updateProcessing(true);
          return;
        }
        updateProcessing(true);
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
        updateProcessing(true);
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
        updateProcessing(true);
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
        updateProcessing(true);
        return;
      }

      if (payload.type === 'final') {
        finalizeRunningToolTraceMessages(
          payload.status === 'error' ? 'failed' : 'completed',
        );
        if (payload.text.trim()) {
          upsertLatestStreamingAssistantMessage(
            sessionId,
            payload.text,
            normalizeMessageMetadata(payload.metadata) ?? {
              kind: 'final',
              turn_complete: true,
            },
          );
        }
        updateProcessing(false);
        updateAwaitingRefresh(true);
        void loadMessages(sessionId, { background: true });
        return;
      }

      if (payload.type === 'error') {
        const activeStreamingMessageIds = getActiveStreamingMessageIds();
        resetStreamingMessageRefs();
        appendAssistantErrorMessage(
          sessionId,
          getAiChatStreamErrorMessage(payload),
          { removeMessageIds: activeStreamingMessageIds },
        );
        updateProcessing(false);
        updateAwaitingRefresh(false);
        return;
      }
    };

    const connectStream = async () => {
      if (
        closedByEffect ||
        activeSessionRef.current !== sessionId ||
        isStreamInterrupted(sessionId)
      ) {
        return;
      }

      let streamTicket: string;
      try {
        const result = await chatSessionsApi.createStreamTicket(sessionId);
        streamTicket = result.ticket;
      } catch {
        scheduleReconnect();
        return;
      }

      if (
        closedByEffect ||
        activeSessionRef.current !== sessionId ||
        isStreamInterrupted(sessionId)
      ) {
        return;
      }

      let currentSocket: WebSocket;
      try {
        currentSocket = new WebSocket(
          buildChatSessionStreamUrl(sessionId, streamTicket),
        );
      } catch {
        scheduleReconnect();
        return;
      }

      socket = currentSocket;
      streamSocketRef.current = currentSocket;

      currentSocket.onmessage = handleStreamMessage;

      currentSocket.onerror = () => {
        if (
          activeSessionRef.current === sessionId &&
          hasRecoverableStreamActivity()
        ) {
          appendReconnectNoticeMessage(sessionId);
          updateAwaitingRefresh(true);
        }
      };

      currentSocket.onclose = () => {
        if (streamSocketRef.current === currentSocket) {
          streamSocketRef.current = null;
        }
        if (!closedByEffect && activeSessionRef.current === sessionId) {
          if (hasRecoverableStreamActivity()) {
            appendReconnectNoticeMessage(sessionId);
            updateAwaitingRefresh(true);
          }
          scheduleReconnect();
        }
      };
    };

    void connectStream();

    return () => {
      closedByEffect = true;
      clearReconnectTimeout();
      cancelStreamFlush();
      socket?.close();
      if (streamSocketRef.current === socket) {
        streamSocketRef.current = null;
      }
      resetStreamingMessageRefs();
    };
  }, [
    beginStreamingAssistantTurn,
    appendAssistantErrorMessage,
    appendReconnectNoticeMessage,
    finalizeRunningToolTraceMessages,
    getActiveStreamingMessageIds,
    isStreamInterrupted,
    loadMessages,
    options.selectedSession,
    resetStreamingMessageRefs,
    streamReconnectNonce,
    updateAwaitingRefresh,
    updateProcessing,
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
    if (!isPending || !scrollRef.current || !shouldAutoScrollRef.current)
      return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [isPending]);

  const stopGenerating = useCallback(() => {
    const sessionId = activeSessionRef.current || options.selectedSession;
    if (sessionId) {
      interruptedStreamSessionRef.current = sessionId;
      void chatSessionsApi.cancel(sessionId).catch(() => undefined);
    }

    sendAbortControllerRef.current?.abort();
    const socket = streamSocketRef.current;
    if (socket) {
      streamSocketRef.current = null;
      socket.close();
    }

    databaseProcessingRef.current = false;
    resetStreamingMessageRefs();
    setSending(false);
    updateProcessing(false);
    updateAwaitingRefresh(false);
    inputRef.current?.focus();
  }, [
    options.selectedSession,
    resetStreamingMessageRefs,
    updateAwaitingRefresh,
    updateProcessing,
  ]);

  const sendMessageWithOptions = useCallback(
    async (text: string, sendOptions?: ChatMessageSendOptions) => {
      const content = text.trim();
      if (!content || isPending) return false;
      if (activeContinuationBlocked) return false;
      if (!options.selectedSession && !options.chatAvailable) return false;

      const previousInterruptedSession = interruptedStreamSessionRef.current;
      interruptedStreamSessionRef.current = null;
      if (previousInterruptedSession) {
        setStreamReconnectNonce((value) => value + 1);
      }
      const abortController = new AbortController();
      sendAbortControllerRef.current = abortController;
      setSending(true);
      lastStreamActivityRef.current = Date.now();
      shouldAutoScrollRef.current = true;

      try {
        let sessionId = options.selectedSession;

        if (!sessionId) {
          if (creatingRef.current) return false;

          creatingRef.current = true;

          try {
            const newSession = await options.createSession();
            if (!newSession) return false;
            if (abortController.signal.aborted) return false;

            sessionId = newSession.id;
            activeSessionRef.current = sessionId;
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
        if (abortController.signal.aborted) return false;

        try {
          const { session_title: sessionTitle } =
            await sendChatSessionMessageWithOptions(
              chatSessionsApi.send,
              sessionId,
              content,
              sendOptions,
              { signal: abortController.signal },
            );

          const refreshed = await loadMessages(sessionId, { background: true });
          if (!refreshed.ok) {
            appendReconnectNoticeMessage(sessionId);
            updateAwaitingRefresh(true);
            return false;
          }
          if (!refreshed.active) {
            return false;
          }
          if (refreshed.processing) {
            updateAwaitingRefresh(true);
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
          if (abortController.signal.aborted) {
            updateProcessing(false);
            updateAwaitingRefresh(false);
            return false;
          }

          if (isRecoverableChatSendInterruption(error)) {
            const refreshed = await loadMessages(sessionId, {
              background: true,
            });
            if (!refreshed.ok) {
              appendReconnectNoticeMessage(sessionId);
              updateAwaitingRefresh(true);
              return false;
            }
            if (!refreshed.active) {
              return false;
            }
            if (refreshed.processing) {
              updateAwaitingRefresh(true);
              return false;
            }
            if (hasFinalAssistantAfterLatestUser(refreshed.messages)) {
              return true;
            }
          }

          const errorMessage = getAiChatSendErrorMessage(error);
          if (errorMessage === AI_CHAT_RECONNECTING_MESSAGE) {
            appendReconnectNoticeMessage(sessionId);
            updateAwaitingRefresh(true);
            return false;
          }
          appendAssistantErrorMessage(sessionId, errorMessage);
          return false;
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : DEFAULT_AI_CHAT_ERROR_MESSAGE;
        const messageId = `opt-send-error-${Date.now()}-${localMessageSequenceRef.current}`;
        localMessageSequenceRef.current += 1;
        setMessages((previous) => [
          ...previous,
          {
            id: messageId,
            account_id: 'web',
            sender: '',
            sender_name: '',
            content: errorMessage,
            timestamp: new Date().toISOString(),
            is_from_me: true,
            is_bot_message: true,
            metadata: {
              kind: 'error',
              turn_complete: true,
            },
          },
        ]);
        return false;
      } finally {
        if (sendAbortControllerRef.current === abortController) {
          sendAbortControllerRef.current = null;
        }
        setSending(false);
        inputRef.current?.focus();
      }
    },
    [
      activeContinuationBlocked,
      appendAssistantErrorMessage,
      appendReconnectNoticeMessage,
      isPending,
      loadMessages,
      options,
      updateAwaitingRefresh,
      updateProcessing,
    ],
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
    loadedSessionId,
    continuationBlocked: activeContinuationBlocked,
    continuationBlockMessage: activeContinuationBlocked
      ? continuationBlockMessage
      : '',
    scrollRef,
    inputRef,
    sendMessage,
    sendMessageWithOptions,
    stopGenerating,
    refreshMessages,
  };
}
