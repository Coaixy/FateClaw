'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from 'react';

import {
  chatSessionsApi,
  type ChatSession,
  type ChatSessionRequestOptions,
  type ChatSessionSendOptions,
  type ChatSessionStreamEvent,
  type Message,
} from '../api';
import { openChatStream } from '../utils/chat-stream';
import { useChatRun } from './use-chat-run';
import { useChatStreamMessages } from './use-chat-stream-messages';
import { useChatViewport } from './use-chat-viewport';
import { areMessagesEqual, isNearBottom } from '../utils/display';
import { shouldPollChatMessages } from '../utils/polling';
import {
  CHAT_MESSAGE_PAGE_SIZE,
  fetchRecentMessageWindow,
  mergeStreamingTurnMessages,
  reconcileMessagePage,
} from '../utils/message-history';
import { getChatTurnOutcome } from '../utils/run-state';
import { sanitizeToolPath } from '../utils/tool-path';

const DEFAULT_AI_CHAT_SESSION_TITLE = '未设置标题';
const CHAT_POLL_INTERVAL_MS = 1200;
// 单页消息加载条数;上滑到顶时按此步长向更早翻页。
const MESSAGE_PAGE_SIZE = CHAT_MESSAGE_PAGE_SIZE;
const DEFAULT_AI_CHAT_ERROR_MESSAGE = '抱歉，AI 服务暂时不可用，请稍后重试';
const GENERIC_REQUEST_FAILED_MESSAGE = '请求失败，请检查后重试';
const AI_CHAT_RECONNECTING_MESSAGE = '请求断开，正在重连';
// WS 连续静默超过这个时长(自最近一次收到任意流事件算起)，判定"回复较慢"，
// 提示用户并给出一键重试；间隔决定检测粒度，不需要很密。
const REPLY_SILENCE_THRESHOLD_MS = 60_000;
const REPLY_SILENCE_CHECK_INTERVAL_MS = 5_000;

export type ChatMessageSendOptions = ChatSessionSendOptions;
export { getAiChatStreamReconnectDelay } from '../utils/chat-stream';
export { mergeStreamingMessageUpdates } from './use-chat-stream-messages';

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

function normalizeMessageMetadata(value: unknown): Message['metadata'] {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Message['metadata'])
    : null;
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

/**
 * 已加载会话的元信息：当前已加载哪个会话、是否被续聊门禁拦截、拦截文案。
 * 三者在 loadMessages 成功时一起写入、切换/清空会话时一起重置，属同一份快照，
 * 用 reducer 一次 dispatch 翻转，避免在同一 effect 内三连 setState 级联重渲染。
 */
interface LoadedSessionMetaState {
  loadedSessionId: string;
  continuationBlocked: boolean;
  continuationBlockMessage: string;
}

type LoadedSessionMetaAction =
  | { type: 'loaded'; sessionId: string; blocked: boolean; message: string }
  | { type: 'reset' };

const INITIAL_LOADED_SESSION_META: LoadedSessionMetaState = {
  loadedSessionId: '',
  continuationBlocked: false,
  continuationBlockMessage: '',
};

function loadedSessionMetaReducer(
  // 该 reducer 每个分支都返回全新快照，不依赖旧 state，故参数前缀下划线表明有意未用。
  _state: LoadedSessionMetaState,
  action: LoadedSessionMetaAction,
): LoadedSessionMetaState {
  switch (action.type) {
    case 'loaded':
      return {
        loadedSessionId: action.sessionId,
        continuationBlocked: action.blocked,
        continuationBlockMessage: action.message,
      };
    case 'reset':
      return INITIAL_LOADED_SESSION_META;
  }
}

/**
 * 上滑分页状态：是否还有更早消息、是否正在加载更早消息。两者同属一套翻页流程，
 * 切换会话时一起重置，用 reducer 单次 dispatch 收敛，避免级联重渲染。
 * 注意：与之并存的 hasMoreOlderRef / loadingOlderRef 仍由各自原有逻辑维护（供 scroll 事件同步读取）。
 */
interface PaginationState {
  hasMoreOlder: boolean;
  loadingOlder: boolean;
}

type PaginationAction =
  | { type: 'set-has-more'; value: boolean }
  | { type: 'older-start' }
  | { type: 'older-end' }
  | { type: 'reset' };

function paginationReducer(
  state: PaginationState,
  action: PaginationAction,
): PaginationState {
  switch (action.type) {
    case 'set-has-more':
      return { ...state, hasMoreOlder: action.value };
    case 'older-start':
      return { ...state, loadingOlder: true };
    case 'older-end':
      return { ...state, loadingOlder: false };
    case 'reset':
      return { hasMoreOlder: false, loadingOlder: false };
  }
}

/**
 * 请求在途状态：加载历史（loading）与发送消息（sending）两个互相独立但同属「请求是否在途」的标志。
 * 它们在切换会话时一起重置，用 reducer 翻转使该重置只需一次 dispatch，避免级联重渲染。
 */
interface RequestStatusState {
  loading: boolean;
  sending: boolean;
}

type RequestStatusAction =
  | { type: 'set-loading'; value: boolean }
  | { type: 'set-sending'; value: boolean }
  | { type: 'reset' };

function requestStatusReducer(
  state: RequestStatusState,
  action: RequestStatusAction,
): RequestStatusState {
  switch (action.type) {
    case 'set-loading':
      return { ...state, loading: action.value };
    case 'set-sending':
      return { ...state, sending: action.value };
    case 'reset':
      return { loading: false, sending: false };
  }
}

export function useChatMessages({
  chatAvailable,
  selectedSession,
  selectedSessionRevision,
  sessions,
  createSession,
  touchSession,
}: {
  chatAvailable: boolean;
  selectedSession: string;
  selectedSessionRevision: number;
  sessions: ChatSession[];
  createSession: (
    onCreated?: (session: ChatSession) => void,
  ) => Promise<ChatSession | null>;
  touchSession: (sessionId: string, patch: Partial<ChatSession>) => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [stopping, setStopping] = useState(false);
  const stoppingRef = useRef(false);
  const admissionRef = useRef<Promise<void> | null>(null);
  const activeSendOperationRef = useRef<{
    sessionId: string;
    admission: Promise<void>;
  } | null>(null);
  const historySessionRef = useRef('');
  const submissionBoundaryRef = useRef<{
    sessionId: string;
    knownIds: Set<string>;
  } | null>(null);
  const latestMessagesRequestRef = useRef(0);
  const foregroundLoadRequestRef = useRef<number | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  // 请求在途状态(loading/sending)合并到 reducer,切换会话时一次 dispatch 重置。
  const [{ loading, sending }, dispatchRequestStatus] = useReducer(
    requestStatusReducer,
    { loading: false, sending: false },
  );
  const [processing, setProcessing] = useState(false);
  const [awaitingRefresh, setAwaitingRefresh] = useState(false);
  // WS 长时间静默(见 REPLY_SILENCE_THRESHOLD_MS)时置 true，驱动"回复较慢"提示 + 重试入口。
  const [replySlow, setReplySlow] = useState(false);
  // 已加载会话元信息(loadedSessionId/continuationBlocked/continuationBlockMessage)合并到 reducer。
  const [
    { loadedSessionId, continuationBlocked, continuationBlockMessage },
    dispatchLoadedSessionMeta,
  ] = useReducer(loadedSessionMetaReducer, INITIAL_LOADED_SESSION_META);
  const [streamReconnectNonce, setStreamReconnectNonce] = useState(0);
  // 上滑分页状态(hasMoreOlder/loadingOlder)合并到 reducer。
  const [{ hasMoreOlder, loadingOlder }, dispatchPagination] = useReducer(
    paginationReducer,
    { hasMoreOlder: false, loadingOlder: false },
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pollingVisitRef = useRef<number | null>(null);
  const lastPollAtRef = useRef<number | null>(null);
  const lastStreamProgressAtRef = useRef<number | null>(null);
  const streamConnectedRef = useRef(false);
  const sendingRef = useRef(false);
  const processingRef = useRef(false);
  const awaitingRefreshRef = useRef(false);
  const databaseProcessingRef = useRef(false);
  const activeSessionRef = useRef('');
  const { run, runRef, transitionRun, acceptRunEvent } =
    useChatRun(activeSessionRef);
  // 流式回调通过 ref 读取最新会话元数据，避免标题/更新时间变化时重建 WebSocket 连接。
  const sessionsRef = useRef(sessions);
  const previousSelectedSessionRef = useRef('');
  const sessionVisitRef = useRef(0);
  // 持有最新 messages 引用,供 loadOlderMessages 在闭包外读取最早一条做游标。
  const messagesRef = useRef<Message[]>([]);
  // 加载更早消息的重入/可用状态镜像,供 scroll 事件同步读取。
  const loadingOlderRef = useRef(false);
  const hasMoreOlderRef = useRef(false);
  // 上滑插入前记录的滚动几何,用于插入后把视口锚回原位,避免跳动。
  const prependAnchorRef = useRef<{ height: number; top: number } | null>(null);
  const creatingRef = useRef(false);
  const disconnectStreamRef = useRef<(() => void) | null>(null);
  const sendAbortControllerRef = useRef<AbortController | null>(null);
  const interruptedStreamSessionRef = useRef<string | null>(null);
  const localMessageSequenceRef = useRef(0);
  // 最近一次收到任意可识别 WS 流事件的时间戳；发送时先设一次初始值，
  // 覆盖"WS 还没收到任何事件"这种起始静默状态。配合下方静默检测判断要不要提示"回复较慢"。
  const lastStreamEventAtRef = useRef<number | null>(null);
  // 本轮实际发送给后端的用户消息原文和选项(含贴盘面等场景要原样带上的字段)，
  // 供"一键重试"在不知道用户是否已经清空输入框的情况下，仍能重新发出同一条消息。
  const lastSentMessageContentRef = useRef<string | null>(null);
  const lastSentMessageOptionsRef = useRef<ChatMessageSendOptions | undefined>(
    undefined,
  );
  const isPending = sending || processing || awaitingRefresh || stopping;

  const activeContinuationBlocked = Boolean(
    selectedSession &&
    loadedSessionId === selectedSession &&
    continuationBlocked,
  );

  const isStreamInterrupted = useCallback(
    (sessionId: string) => interruptedStreamSessionRef.current === sessionId,
    [],
  );

  const closeStream = useCallback(() => {
    const disconnect = disconnectStreamRef.current;
    disconnectStreamRef.current = null;
    streamConnectedRef.current = false;
    lastStreamProgressAtRef.current = null;
    disconnect?.();
  }, []);

  const {
    getActiveStreamingMessageIds,
    flushStreamingMessageUpdates,
    resetStreamingMessageRefs,
    beginStreamingAssistantTurn,
    upsertStreamingAssistantMessage,
    upsertThinkingMessage,
    upsertToolTraceMessage,
    projectToolCall,
    finalizeRunningToolTraceMessages,
  } = useChatStreamMessages(setMessages, sessionsRef);

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

  useLayoutEffect(() => {
    activeSessionRef.current = selectedSession || '';
    sessionVisitRef.current += 1;
    resetStreamingMessageRefs();
  }, [selectedSession, selectedSessionRevision, resetStreamingMessageRefs]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  // 把最新的 messages / hasMoreOlder 同步到 ref,供 scroll 事件与翻页回调无闭包读取。
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    hasMoreOlderRef.current = hasMoreOlder;
  }, [hasMoreOlder]);

  /**
   * 向更早翻页:以当前最早一条消息的 timestamp 作游标拉取上一页,前置插入。
   *
   * 通过 ref 读取重入/可用状态,可安全地由 scroll 事件高频触发。
   */
  const loadOlderMessages = useCallback(async () => {
    const sessionId = activeSessionRef.current;
    const visit = sessionVisitRef.current;
    if (
      !sessionId ||
      historySessionRef.current !== sessionId ||
      loadingOlderRef.current ||
      !hasMoreOlderRef.current
    ) {
      return;
    }
    // 列表按时间升序,[0] 即最早一条;以其 timestamp 作 before 游标(后端 timestamp < before)。
    const oldest = messagesRef.current[0];
    if (!oldest) return;

    loadingOlderRef.current = true;
    dispatchPagination({ type: 'older-start' });

    try {
      const data = await chatSessionsApi.messages(
        sessionId,
        MESSAGE_PAGE_SIZE,
        oldest.timestamp,
        oldest.id,
      );
      if (
        activeSessionRef.current !== sessionId ||
        sessionVisitRef.current !== visit
      )
        return;
      const olderMessages = [...data.messages].reverse();
      if (olderMessages.length === 0) {
        dispatchPagination({ type: 'set-has-more', value: false });
        prependAnchorRef.current = null;
        return;
      }
      const scrollElement = scrollRef.current;
      prependAnchorRef.current = scrollElement
        ? { height: scrollElement.scrollHeight, top: scrollElement.scrollTop }
        : null;
      setMessages((previous) => {
        if (
          activeSessionRef.current !== sessionId ||
          sessionVisitRef.current !== visit
        )
          return previous;
        // Keep overlapping pages idempotent without replacing the current live tail.
        const existingIds = new Set(previous.map((message) => message.id));
        const merged = olderMessages.filter(
          (message) => !existingIds.has(message.id),
        );
        if (merged.length === 0) {
          prependAnchorRef.current = null;
          return previous;
        }
        const next = [...merged, ...previous];
        messagesRef.current = next;
        return next;
      });
      // 后端返回满一页即认为仍有更早消息。
      dispatchPagination({
        type: 'set-has-more',
        value: olderMessages.length >= MESSAGE_PAGE_SIZE,
      });
    } catch {
      if (
        activeSessionRef.current === sessionId &&
        sessionVisitRef.current === visit
      ) {
        prependAnchorRef.current = null;
      }
    } finally {
      if (
        activeSessionRef.current === sessionId &&
        sessionVisitRef.current === visit
      ) {
        loadingOlderRef.current = false;
        dispatchPagination({ type: 'older-end' });
      }
    }
  }, []);

  const {
    resetFollowing,
    shouldAutoScrollRef,
    followingLatest,
    showScrollToLatest,
    scrollToLatest,
  } = useChatViewport({
    messages,
    isPending,
    scrollRef,
    prependAnchorRef,
    loadOlderMessages,
  });

  const loadMessages = useCallback(
    async (
      sessionId: string,
      loadOptions?: { background?: boolean },
    ): Promise<LoadMessagesResult> => {
      if (!sessionId) return { ok: false };

      const isBackground = loadOptions?.background ?? false;
      if (!isBackground) {
        dispatchRequestStatus({ type: 'set-loading', value: true });
      }

      const requestVersion = ++latestMessagesRequestRef.current;
      const visit = sessionVisitRef.current;
      const isCurrentVisit = () =>
        activeSessionRef.current === sessionId &&
        sessionVisitRef.current === visit;
      if (!isBackground) foregroundLoadRequestRef.current = requestVersion;
      try {
        const previousWindow =
          historySessionRef.current === sessionId ? messagesRef.current : [];
        const data = await fetchRecentMessageWindow(
          (before, beforeId) =>
            chatSessionsApi.messages(
              sessionId,
              MESSAGE_PAGE_SIZE,
              before,
              beforeId,
            ),
          previousWindow,
        );
        if (
          !isCurrentVisit() ||
          requestVersion !== latestMessagesRequestRef.current
        ) {
          return { ok: true, active: false };
        }

        setHistoryError(null);
        dispatchLoadedSessionMeta({
          type: 'loaded',
          sessionId,
          blocked: Boolean(data.continuation_blocked),
          message: data.continuation_block_message || '',
        });
        const stillProcessing =
          data.processing && !isStreamInterrupted(sessionId);
        databaseProcessingRef.current = stillProcessing;
        // 仅在前台(切换/刷新)时据返回条数判断是否还有更早消息;
        // 后台轮询不改动该标记,避免大窗口刷新时误判。
        if (!isBackground) {
          dispatchPagination({
            type: 'set-has-more',
            value: data.messages.length >= MESSAGE_PAGE_SIZE,
          });
        }

        const nextMessages = [...data.messages].reverse();
        const boundary =
          submissionBoundaryRef.current?.sessionId === sessionId
            ? submissionBoundaryRef.current
            : null;
        const outcome = getChatTurnOutcome(
          nextMessages,
          data.processing_request_id ?? runRef.current.requestId,
          boundary?.knownIds,
        );
        const preserveUnconfirmedSubmission = Boolean(
          boundary &&
          !outcome &&
          ['queued', 'running', 'syncing', 'stopping'].includes(
            runRef.current.phase,
          ) &&
          !nextMessages.some(
            (message) =>
              !message.is_bot_message && !boundary.knownIds.has(message.id),
          ),
        );
        const activeStreamingMessageIds = getActiveStreamingMessageIds();
        const streamingResolved =
          isBackground &&
          activeStreamingMessageIds.length > 0 &&
          outcome !== null;
        if (streamingResolved) {
          resetStreamingMessageRefs();
        }
        const canFollow =
          !isBackground ||
          !scrollRef.current ||
          shouldAutoScrollRef.current ||
          isNearBottom(scrollRef.current);

        setMessages((previous) => {
          if (!isCurrentVisit()) return previous;
          const refreshed =
            previousWindow.length > 0
              ? reconcileMessagePage(previous, nextMessages)
              : nextMessages;
          const visibleMessages = preserveUnconfirmedSubmission
            ? previous
            : isBackground && !streamingResolved && stillProcessing
              ? mergeStreamingTurnMessages(
                  refreshed,
                  previous,
                  activeStreamingMessageIds,
                )
              : refreshed;
          historySessionRef.current = sessionId;
          messagesRef.current = visibleMessages;

          return isBackground &&
            visibleMessages.length === 0 &&
            previous.length > 0
            ? previous
            : areMessagesEqual(previous, visibleMessages)
              ? previous
              : ((shouldAutoScrollRef.current = canFollow), visibleMessages);
        });
        updateProcessing(stillProcessing);
        const pendingOutcome = outcome;
        const needsReconciliation =
          !isStreamInterrupted(sessionId) &&
          !pendingOutcome &&
          ['queued', 'running', 'syncing'].includes(runRef.current.phase);
        updateAwaitingRefresh(
          (isBackground && stillProcessing) || needsReconciliation,
        );
        if (!isStreamInterrupted(sessionId) && !stoppingRef.current) {
          const requestId =
            data.processing_request_id ??
            runRef.current.requestId ??
            (!boundary
              ? [...nextMessages]
                  .reverse()
                  .find(
                    (message) =>
                      message.metadata?.kind === 'final' ||
                      message.metadata?.kind === 'error',
                  )?.metadata?.request_id
              : null);
          if (stillProcessing)
            transitionRun(
              sessionId,
              runRef.current.phase === 'running' ? 'running' : 'queued',
              requestId,
              runRef.current.error,
            );
          else if (outcome) transitionRun(sessionId, outcome, requestId);
          else if (
            runRef.current.phase === 'queued' ||
            runRef.current.phase === 'running' ||
            runRef.current.phase === 'syncing'
          ) {
            transitionRun(sessionId, 'syncing', requestId);
          }
        }
        return {
          ok: true,
          active: true,
          messages: nextMessages,
          processing: stillProcessing,
        };
      } catch (error) {
        if (
          isCurrentVisit() &&
          requestVersion === latestMessagesRequestRef.current
        ) {
          setHistoryError(
            error instanceof Error ? error.message : '加载历史消息失败，请重试',
          );
        }
        return { ok: false };
      } finally {
        if (
          isCurrentVisit() &&
          foregroundLoadRequestRef.current === requestVersion
        ) {
          foregroundLoadRequestRef.current = null;
          dispatchRequestStatus({ type: 'set-loading', value: false });
        }
      }
    },
    [
      getActiveStreamingMessageIds,
      isStreamInterrupted,
      resetStreamingMessageRefs,
      runRef,
      shouldAutoScrollRef,
      updateAwaitingRefresh,
      updateProcessing,
      transitionRun,
    ],
  );

  useEffect(() => {
    const previousSelectedSession = previousSelectedSessionRef.current;
    previousSelectedSessionRef.current = selectedSession;

    // 切换会话:重置分页窗口与状态,避免沿用上一会话的窗口大小/游标标记。
    historySessionRef.current = '';
    foregroundLoadRequestRef.current = null;
    setHistoryError(null);
    const isCreatedSession =
      previousSelectedSession === '' &&
      activeSendOperationRef.current?.sessionId === selectedSession;
    if (!isCreatedSession && previousSelectedSession !== selectedSession) {
      activeSendOperationRef.current = null;
      dispatchRequestStatus({ type: 'reset' });
      sendingRef.current = false;
      stoppingRef.current = false;
      setStopping(false);
      lastSentMessageContentRef.current = null;
      lastSentMessageOptionsRef.current = undefined;
      interruptedStreamSessionRef.current = null;
      submissionBoundaryRef.current = null;
      transitionRun(selectedSession, 'idle', null);
      resetFollowing();
    }
    lastPollAtRef.current = null;
    loadingOlderRef.current = false;
    prependAnchorRef.current = null;
    dispatchPagination({ type: 'reset' });

    if (selectedSession) {
      updateProcessing(false);
      updateAwaitingRefresh(false);
      databaseProcessingRef.current = false;
      dispatchLoadedSessionMeta({ type: 'reset' });
      void loadMessages(selectedSession, {
        background:
          sendingRef.current &&
          (previousSelectedSession === selectedSession || isCreatedSession),
      });
      return;
    }

    setMessages([]);
    dispatchRequestStatus({ type: 'reset' });
    updateProcessing(false);
    updateAwaitingRefresh(false);
    databaseProcessingRef.current = false;
    dispatchLoadedSessionMeta({ type: 'reset' });
  }, [
    loadMessages,
    selectedSession,
    selectedSessionRevision,
    resetFollowing,
    transitionRun,
    updateAwaitingRefresh,
    updateProcessing,
  ]);

  const pollMessages = useCallback(async () => {
    const sessionId = selectedSession;
    const visit = sessionVisitRef.current;
    if (
      !sessionId ||
      sessionId !== activeSessionRef.current ||
      pollingVisitRef.current === visit ||
      document.visibilityState === 'hidden' ||
      (!processingRef.current && !awaitingRefreshRef.current)
    ) {
      return;
    }

    const now = Date.now();
    if (
      !shouldPollChatMessages({
        now,
        lastPollAt: lastPollAtRef.current,
        lastProgressAt: lastStreamProgressAtRef.current,
        streamConnected: streamConnectedRef.current,
      })
    )
      return;

    lastPollAtRef.current = now;
    pollingVisitRef.current = visit;
    try {
      await loadMessages(sessionId, { background: true });
    } finally {
      if (pollingVisitRef.current === visit) pollingVisitRef.current = null;
    }
  }, [loadMessages, selectedSession]);

  useEffect(() => {
    if (!selectedSession || (!processing && !awaitingRefresh)) return;

    void pollMessages();

    // Keep the recovery tick short; healthy streams only query on reconciliation.
    const intervalId = window.setInterval(() => {
      void pollMessages();
    }, CHAT_POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [awaitingRefresh, selectedSession, pollMessages, processing]);

  // WS 静默检测：仅在有请求在途时跑，每隔 REPLY_SILENCE_CHECK_INTERVAL_MS 检查一次
  // 距最近一次收到流事件过去了多久，超过阈值就提示"回复较慢"；请求结束后自动清掉。
  useEffect(() => {
    if (!isPending) {
      setReplySlow(false);
      return;
    }

    const checkSilence = () => {
      const lastAt = lastStreamEventAtRef.current ?? Date.now();
      setReplySlow(Date.now() - lastAt >= REPLY_SILENCE_THRESHOLD_MS);
    };
    checkSilence();
    const intervalId = window.setInterval(
      checkSilence,
      REPLY_SILENCE_CHECK_INTERVAL_MS,
    );

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isPending]);

  useEffect(() => {
    if (!selectedSession) return;

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
  }, [selectedSession, pollMessages]);

  const appendAssistantErrorMessage = useCallback(
    (
      sessionId: string,
      content: string,
      appendOptions?: { removeMessageIds?: string[] },
    ) => {
      const accountId =
        sessionsRef.current.find((session) => session.id === sessionId)
          ?.account_id ?? 'web';
      if (activeSessionRef.current !== sessionId) return;
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
    [],
  );

  const appendReconnectNoticeMessage = useCallback((sessionId: string) => {
    if (activeSessionRef.current !== sessionId) return;
    const accountId =
      sessionsRef.current.find((session) => session.id === sessionId)
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
  }, []);

  const applyStreamEvent = useCallback(
    (
      sessionId: string,
      payload: Exclude<ChatSessionStreamEvent, { type: 'connected' }>,
    ) => {
      const request = acceptRunEvent(sessionId, payload);
      if (!request) return;
      if (request === 'new-request') {
        submissionBoundaryRef.current = null;
        void loadMessages(sessionId, { background: true });
      }

      // connected 只是连接层面的握手确认，不代表业务有进展，不计入静默判断——
      // 否则断线重连本身就会不断掩盖"AI 其实一直没真正开始处理"这件事。
      // 走到这里说明是下面这批真正表示业务进展的事件类型之一。
      lastStreamEventAtRef.current = Date.now();
      lastStreamProgressAtRef.current = lastStreamEventAtRef.current;
      if (
        !stoppingRef.current &&
        payload.type !== 'final' &&
        payload.type !== 'error'
      )
        transitionRun(sessionId, 'running', undefined, runRef.current.error);

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
        upsertStreamingAssistantMessage(
          sessionId,
          payload.snapshot,
          typeof payload.turnIndex === 'number'
            ? `turn-${payload.turnIndex}`
            : undefined,
        );
        updateProcessing(true);
        return;
      }

      if (payload.type === 'thinking_delta') {
        upsertThinkingMessage(
          sessionId,
          payload.snapshot,
          typeof payload.turnIndex === 'number' ? payload.turnIndex : undefined,
        );
        updateProcessing(true);
        return;
      }

      if (payload.type === 'assistant_message' && payload.text.trim()) {
        upsertStreamingAssistantMessage(
          sessionId,
          payload.text,
          typeof payload.turnIndex === 'number'
            ? `turn-${payload.turnIndex}`
            : undefined,
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

      if (
        payload.type === 'tool_start' ||
        payload.type === 'tool_update' ||
        payload.type === 'tool_end'
      ) {
        projectToolCall(sessionId, payload);
        updateProcessing(true);
        return;
      }

      if (payload.type === 'message') {
        void loadMessages(sessionId, { background: true });
        updateProcessing(true);
        return;
      }

      if (payload.type === 'final') {
        transitionRun(
          sessionId,
          stoppingRef.current ? 'stopping' : 'syncing',
          payload.requestId,
        );
        finalizeRunningToolTraceMessages(
          payload.status === 'error' ? 'failed' : 'completed',
        );
        if (payload.text.trim()) {
          upsertStreamingAssistantMessage(
            sessionId,
            payload.text,
            undefined,
            normalizeMessageMetadata(payload.metadata) ?? {
              kind: 'final',
              turn_complete: true,
            },
          );
        }
        // 最终事件必须把本帧最后快照立即提交，不能等下一帧后再与数据库刷新竞争。
        flushStreamingMessageUpdates();
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
        transitionRun(
          sessionId,
          'failed',
          payload.requestId,
          getAiChatStreamErrorMessage(payload),
        );
        updateProcessing(false);
        updateAwaitingRefresh(false);
        return;
      }
    },
    [
      acceptRunEvent,
      appendAssistantErrorMessage,
      beginStreamingAssistantTurn,
      finalizeRunningToolTraceMessages,
      flushStreamingMessageUpdates,
      getActiveStreamingMessageIds,
      loadMessages,
      projectToolCall,
      resetStreamingMessageRefs,
      runRef,
      transitionRun,
      updateAwaitingRefresh,
      updateProcessing,
      upsertStreamingAssistantMessage,
      upsertThinkingMessage,
      upsertToolTraceMessage,
    ],
  );

  useEffect(() => {
    const sessionId = selectedSession;
    if (!sessionId) return;
    const visit = sessionVisitRef.current;

    disconnectStreamRef.current = openChatStream(sessionId, {
      isCurrent: () =>
        sessionVisitRef.current === visit &&
        activeSessionRef.current === sessionId &&
        !isStreamInterrupted(sessionId),
      onConnected: () => {
        streamConnectedRef.current = true;
        setMessages(withoutReconnectNoticeMessages);
      },
      onDisconnected: () => {
        streamConnectedRef.current = false;
        lastStreamProgressAtRef.current = null;
        if (
          sendingRef.current ||
          databaseProcessingRef.current ||
          awaitingRefreshRef.current
        ) {
          appendReconnectNoticeMessage(sessionId);
          updateAwaitingRefresh(true);
        }
      },
      onEvent: (event) => applyStreamEvent(sessionId, event),
    });

    return () => {
      closeStream();
      resetStreamingMessageRefs();
    };
  }, [
    appendReconnectNoticeMessage,
    applyStreamEvent,
    closeStream,
    isStreamInterrupted,
    selectedSession,
    selectedSessionRevision,
    resetStreamingMessageRefs,
    streamReconnectNonce,
    updateAwaitingRefresh,
  ]);

  /** Local interruption follows a successful cancellation acknowledgement. */
  const resetStreamingStateForInterrupt = useCallback(() => {
    sendAbortControllerRef.current?.abort();
    if (interruptedStreamSessionRef.current) closeStream();

    databaseProcessingRef.current = false;
    resetStreamingMessageRefs();
    sendingRef.current = false;
    dispatchRequestStatus({ type: 'set-sending', value: false });
    updateProcessing(false);
    updateAwaitingRefresh(false);
  }, [
    closeStream,
    resetStreamingMessageRefs,
    updateAwaitingRefresh,
    updateProcessing,
  ]);

  const stopGenerating = useCallback(async () => {
    if (stoppingRef.current) return false;
    const sessionId = activeSessionRef.current || selectedSession;
    if (!sessionId && !admissionRef.current) return false;
    const operation = activeSendOperationRef.current;
    let targetSessionId = sessionId;
    let targetVisit: number | null = null;
    let targetRequestId: string | null | undefined;
    stoppingRef.current = true;
    setStopping(true);
    transitionRun(sessionId, 'stopping');
    try {
      // Admission must finish before cancel can target the accepted request.
      await (operation?.admission ?? admissionRef.current);
      const admittedSessionId = operation?.sessionId || sessionId;
      targetSessionId = admittedSessionId;
      if (
        !admittedSessionId ||
        activeSessionRef.current !== admittedSessionId ||
        (operation && activeSendOperationRef.current !== operation)
      )
        return false;
      targetVisit = sessionVisitRef.current;
      targetRequestId = runRef.current.requestId;
      await chatSessionsApi.cancel(admittedSessionId);
      if (
        activeSessionRef.current !== admittedSessionId ||
        sessionVisitRef.current !== targetVisit ||
        runRef.current.requestId !== targetRequestId
      )
        return false;
      const requestId = targetRequestId;
      const outcome = getChatTurnOutcome(
        messagesRef.current,
        requestId,
        submissionBoundaryRef.current?.knownIds,
      );
      interruptedStreamSessionRef.current = outcome ? null : admittedSessionId;
      flushStreamingMessageUpdates();
      resetStreamingStateForInterrupt();
      activeSendOperationRef.current = null;
      transitionRun(admittedSessionId, outcome ?? 'stopped', requestId);
      inputRef.current?.focus();
      return true;
    } catch (error) {
      if (
        activeSessionRef.current === targetSessionId &&
        (targetVisit === null || sessionVisitRef.current === targetVisit) &&
        (targetRequestId === undefined ||
          runRef.current.requestId === targetRequestId)
      ) {
        const outcome = getChatTurnOutcome(
          messagesRef.current,
          runRef.current.requestId,
          submissionBoundaryRef.current?.knownIds,
        );
        if (outcome) {
          transitionRun(targetSessionId, outcome);
          return true;
        }
        transitionRun(
          targetSessionId,
          'running',
          undefined,
          error instanceof Error ? error.message : '停止失败，请重试',
        );
        updateAwaitingRefresh(true);
      }
      return false;
    } finally {
      if (
        activeSessionRef.current === targetSessionId &&
        (targetVisit === null || sessionVisitRef.current === targetVisit)
      ) {
        stoppingRef.current = false;
        setStopping(false);
      }
    }
  }, [
    selectedSession,
    transitionRun,
    flushStreamingMessageUpdates,
    resetStreamingStateForInterrupt,
    runRef,
    updateAwaitingRefresh,
  ]);

  const sendMessageWithOptions = useCallback(
    async (
      text: string,
      sendOptions?: ChatMessageSendOptions,
      internalOptions?: { bypassPendingGuard?: boolean },
    ) => {
      const content = text.trim();
      if (!content) return false;
      // 常规发送时若已有请求在途则拒绝；但「一键重试」(retrySending) 会先取消在途
      // 请求再同步重发，此刻它捕获的 isPending 闭包仍是旧的 true（React 尚未因
      // reset 重渲染），必须显式放行，否则重试会被这道守卫静默拦下、什么都不发。
      if (
        (isPending || sendingRef.current || stoppingRef.current) &&
        !internalOptions?.bypassPendingGuard
      )
        return false;
      if (activeContinuationBlocked) return false;
      if (!selectedSession && !chatAvailable) return false;

      const previousInterruptedSession = interruptedStreamSessionRef.current;
      interruptedStreamSessionRef.current = null;
      if (previousInterruptedSession) {
        setStreamReconnectNonce((value) => value + 1);
      }
      const abortController = new AbortController();
      sendAbortControllerRef.current = abortController;
      let finishAdmission!: () => void;
      const admission = new Promise<void>((resolve) => {
        finishAdmission = resolve;
      });
      admissionRef.current = admission;
      const operation = { sessionId: selectedSession, admission };
      activeSendOperationRef.current = operation;
      submissionBoundaryRef.current = {
        sessionId: selectedSession,
        knownIds: new Set(messagesRef.current.map((message) => message.id)),
      };
      const isCurrentOperation = () =>
        activeSendOperationRef.current === operation &&
        activeSessionRef.current === operation.sessionId;
      sendingRef.current = true;
      let sendingSessionId = selectedSession;
      transitionRun(sendingSessionId, 'queued', null);
      dispatchRequestStatus({ type: 'set-sending', value: true });
      shouldAutoScrollRef.current = true;
      // 供"一键重试"复用；初始化静默计时起点，覆盖 WS 还没收到任何事件的起始状态。
      lastSentMessageContentRef.current = content;
      lastSentMessageOptionsRef.current = sendOptions;
      lastStreamEventAtRef.current = Date.now();
      lastStreamProgressAtRef.current = null;
      setReplySlow(false);

      try {
        let sessionId = selectedSession;

        if (!sessionId) {
          if (creatingRef.current) return false;

          creatingRef.current = true;

          try {
            const newSession = await createSession((created) => {
              if (activeSendOperationRef.current !== operation) return;
              operation.sessionId = created.id;
              activeSessionRef.current = created.id;
              submissionBoundaryRef.current = {
                sessionId: created.id,
                knownIds: new Set(),
              };
              transitionRun(
                created.id,
                stoppingRef.current ? 'stopping' : 'queued',
                null,
              );
            });
            if (!newSession || activeSendOperationRef.current !== operation)
              return false;
            if (abortController.signal.aborted) return false;

            sessionId = newSession.id;
            sendingSessionId = sessionId;
            operation.sessionId = sessionId;
            activeSessionRef.current = sessionId;
            transitionRun(
              sessionId,
              stoppingRef.current ? 'stopping' : 'queued',
              null,
            );
            setMessages([]);
            shouldAutoScrollRef.current = true;
          } finally {
            creatingRef.current = false;
          }
        }

        const optimisticUser: Message = {
          id: `opt-user-${Date.now()}`,
          account_id:
            sessionsRef.current.find((session) => session.id === sessionId)
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
          const { session_title: sessionTitle, request_id: requestId } =
            await sendChatSessionMessageWithOptions(
              chatSessionsApi.send,
              sessionId,
              content,
              sendOptions,
              { signal: abortController.signal },
            );
          finishAdmission();
          if (!isCurrentOperation()) return true;
          if (!isStreamInterrupted(sessionId)) {
            transitionRun(
              sessionId,
              stoppingRef.current ? 'stopping' : 'queued',
              requestId ?? runRef.current.requestId,
            );
          }

          const refreshed = await loadMessages(sessionId, { background: true });
          if (!isCurrentOperation()) return true;
          if (!refreshed.ok) {
            appendReconnectNoticeMessage(sessionId);
            transitionRun(sessionId, 'syncing');
            updateAwaitingRefresh(true);
            return true;
          }
          if (!refreshed.active) {
            return true;
          }
          if (refreshed.processing) {
            updateAwaitingRefresh(true);
          }

          const currentSession = sessionsRef.current.find(
            (session) => session.id === sessionId,
          );
          touchSession(sessionId, {
            updated_at: new Date().toISOString(),
            title:
              sessionTitle ||
              currentSession?.title ||
              DEFAULT_AI_CHAT_SESSION_TITLE,
          });
          return true;
        } catch (error) {
          finishAdmission();
          if (!isCurrentOperation())
            return isRecoverableChatSendInterruption(error);
          if (abortController.signal.aborted) {
            updateProcessing(false);
            updateAwaitingRefresh(false);
            return false;
          }

          if (isRecoverableChatSendInterruption(error)) {
            const refreshed = await loadMessages(sessionId, {
              background: true,
            });
            if (!isCurrentOperation()) return true;
            if (!refreshed.ok) {
              appendReconnectNoticeMessage(sessionId);
              transitionRun(sessionId, 'syncing');
              updateAwaitingRefresh(true);
              return true;
            }
            if (!refreshed.active) {
              return true;
            }
            if (refreshed.processing) {
              updateAwaitingRefresh(true);
              return true;
            }
            if (
              getChatTurnOutcome(
                refreshed.messages,
                runRef.current.requestId,
                submissionBoundaryRef.current?.knownIds,
              )
            ) {
              return true;
            }
          }

          const errorMessage = getAiChatSendErrorMessage(error);
          if (errorMessage === AI_CHAT_RECONNECTING_MESSAGE) {
            appendReconnectNoticeMessage(sessionId);
            transitionRun(sessionId, 'syncing');
            updateAwaitingRefresh(true);
            return true;
          }
          appendAssistantErrorMessage(sessionId, errorMessage);
          transitionRun(sessionId, 'failed', undefined, errorMessage);
          return false;
        }
      } catch (error) {
        if (!isCurrentOperation()) return false;
        transitionRun(sendingSessionId, 'failed');
        const errorMessage =
          error instanceof Error
            ? error.message
            : DEFAULT_AI_CHAT_ERROR_MESSAGE;
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
        finishAdmission();
        if (admissionRef.current === admission) admissionRef.current = null;
        if (sendAbortControllerRef.current === abortController) {
          sendAbortControllerRef.current = null;
        }
        if (isCurrentOperation()) {
          activeSendOperationRef.current = null;
          sendingRef.current = false;
          dispatchRequestStatus({ type: 'set-sending', value: false });
          inputRef.current?.focus();
        }
      }
    },
    [
      activeContinuationBlocked,
      appendAssistantErrorMessage,
      appendReconnectNoticeMessage,
      chatAvailable,
      createSession,
      isPending,
      isStreamInterrupted,
      loadMessages,
      runRef,
      selectedSession,
      shouldAutoScrollRef,
      touchSession,
      transitionRun,
      updateAwaitingRefresh,
      updateProcessing,
    ],
  );

  const sendMessage = useCallback(
    async (text: string) => sendMessageWithOptions(text),
    [sendMessageWithOptions],
  );

  /**
   * "回复较慢"提示里的一键重试：取消当前请求、确认取消真正生效后，
   * 用上一次实际发送的原文重新发一遍，用户不用重新打字。
   */
  const retrySending = useCallback(async () => {
    const sessionId = activeSessionRef.current || selectedSession;
    const content = lastSentMessageContentRef.current;
    if (!sessionId || !content) return false;

    const stopped = await stopGenerating();
    if (!stopped || activeSessionRef.current !== sessionId) return false;
    setReplySlow(false);

    // bypassPendingGuard：此刻 sendMessageWithOptions 闭包捕获的 isPending 仍为
    // true（上面 reset 的 setState 尚未触发重渲染），显式放行这次重发，否则会被
    // 入口的在途守卫拦下——净效果就是「取消了在途请求却没重发」，比不点更糟。
    return sendMessageWithOptions(content, lastSentMessageOptionsRef.current, {
      bypassPendingGuard: true,
    });
  }, [selectedSession, stopGenerating, sendMessageWithOptions]);

  const refreshMessages = useCallback(async () => {
    if (!selectedSession) {
      return;
    }
    await loadMessages(selectedSession, { background: false });
  }, [loadMessages, selectedSession]);

  return {
    messages,
    loading,
    run,
    historyError,
    stopping,
    followingLatest,
    showScrollToLatest,
    scrollToLatest,
    sending: isPending,
    loadedSessionId,
    continuationBlocked: activeContinuationBlocked,
    continuationBlockMessage: activeContinuationBlocked
      ? continuationBlockMessage
      : '',
    hasMoreOlder,
    loadingOlder,
    scrollRef,
    inputRef,
    sendMessage,
    sendMessageWithOptions,
    stopGenerating,
    refreshMessages,
    replySlow,
    retrySending,
  };
}
