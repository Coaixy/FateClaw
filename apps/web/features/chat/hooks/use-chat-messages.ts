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
// 单页消息加载条数;上滑到顶时按此步长向更早翻页。
const MESSAGE_PAGE_SIZE = 50;
// 滚动到距顶部多少像素内触发「加载更早消息」。
const OLDER_LOAD_THRESHOLD_PX = 120;
const CHAT_STREAM_RECONNECT_INITIAL_DELAY_MS = 500;
const CHAT_STREAM_RECONNECT_MAX_DELAY_MS = 8000;
const CHAT_STREAM_RECONNECT_MAX_ATTEMPTS = 6;
// 流式文本按 50ms 合并提交，既保持连续观感，也避免 token 频率直接驱动 React 重渲染。
const STREAMING_UPDATE_INTERVAL_MS = 50;
const DEFAULT_AI_CHAT_ERROR_MESSAGE = '抱歉，AI 服务暂时不可用，请稍后重试';
const GENERIC_REQUEST_FAILED_MESSAGE = '请求失败，请检查后重试';
const AI_CHAT_RECONNECTING_MESSAGE = '请求断开，正在重连';
// WS 连续静默超过这个时长(自最近一次收到任意流事件算起)，判定"回复较慢"，
// 提示用户并给出一键重试；间隔决定检测粒度，不需要很密。
const REPLY_SILENCE_THRESHOLD_MS = 60_000;
const REPLY_SILENCE_CHECK_INTERVAL_MS = 5_000;

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

/** 找到列表里最后一条用户（非 bot）消息的下标；没有则返回 -1。 */
function findLastUserMessageIndex(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (!messages[index].is_bot_message) {
      return index;
    }
  }
  return -1;
}

/**
 * 流式进行中的后台刷新合并：历史以 DB 为准，但「最后一条用户消息之后」的当前回合
 * 完全用实时 previous。
 *
 * 这样当前回合的思考/工具/回答轨迹顺序由 WS 事件决定，避免 DB 工具（途中即落库）与
 * 实时思考（末尾追加）交错错位、以及 DB/实时同一工具因 id 不同而重复闪烁。
 * 实时错误气泡也天然包含在实时尾部里，无需单独保留。
 */
function mergeStreamingTurnMessages(
  dbMessages: Message[],
  previousMessages: Message[],
  activeStreamingMessageIds: string[],
): Message[] {
  if (activeStreamingMessageIds.length === 0) {
    return dbMessages;
  }
  const prevUserIndex = findLastUserMessageIndex(previousMessages);
  if (prevUserIndex === -1) {
    return dbMessages;
  }
  const liveTail = previousMessages.slice(prevUserIndex + 1);
  if (liveTail.length === 0) {
    return dbMessages;
  }
  const dbUserIndex = findLastUserMessageIndex(dbMessages);
  if (dbUserIndex === -1) {
    // 极少：全新会话首轮，用户消息还没落库——直接用实时（含本回合用户消息）。
    return previousMessages.slice(prevUserIndex);
  }
  return [...dbMessages.slice(0, dbUserIndex + 1), ...liveTail];
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

/**
 * 将一次批量提交内累积的流式消息更新合并进当前消息列表。
 *
 * @param previous 当前消息列表。
 * @param updates 本次需要提交的最新消息快照，同一消息在入参中至多出现一次。
 * @returns 保持未变化消息引用稳定的新列表，便于消息行通过 memo 跳过历史重渲染。
 */
export function mergeStreamingMessageUpdates(
  previous: Message[],
  updates: Message[],
): Message[] {
  if (updates.length === 0) return previous;

  const next = [...previous];
  const indexById = new Map(
    previous.map((message, index) => [message.id, index] as const),
  );

  for (const update of updates) {
    const existingIndex = indexById.get(update.id);
    if (existingIndex === undefined) {
      indexById.set(update.id, next.length);
      next.push(update);
      continue;
    }
    next[existingIndex] = update;
  }

  return next;
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

export function useChatMessages(options: {
  chatAvailable: boolean;
  selectedSession: string;
  selectedSessionRevision: number;
  sessions: ChatSession[];
  createSession: () => Promise<ChatSession | null>;
  touchSession: (sessionId: string, patch: Partial<ChatSession>) => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
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
  const pollInFlightRef = useRef(false);
  const sendingRef = useRef(false);
  const processingRef = useRef(false);
  const awaitingRefreshRef = useRef(false);
  const databaseProcessingRef = useRef(false);
  const activeSessionRef = useRef('');
  // 流式回调通过 ref 读取最新会话元数据，避免标题/更新时间变化时重建 WebSocket 连接。
  const sessionsRef = useRef(options.sessions);
  const previousSelectedSessionRef = useRef('');
  const shouldAutoScrollRef = useRef(true);
  // 当前已展开的消息窗口大小;后台刷新用它做 limit,确保不把已加载的历史截断回最近一页。
  const loadedWindowSizeRef = useRef(MESSAGE_PAGE_SIZE);
  // 持有最新 messages 引用,供 loadOlderMessages 在闭包外读取最早一条做游标。
  const messagesRef = useRef<Message[]>([]);
  // 加载更早消息的重入/可用状态镜像,供 scroll 事件同步读取。
  const loadingOlderRef = useRef(false);
  const hasMoreOlderRef = useRef(false);
  // 上滑插入前记录的滚动几何,用于插入后把视口锚回原位,避免跳动。
  const prependAnchorRef = useRef<{ height: number; top: number } | null>(null);
  const creatingRef = useRef(false);
  const streamSocketRef = useRef<WebSocket | null>(null);
  const streamingUpdateTimerRef = useRef<number | null>(null);
  const pendingStreamingUpdatesRef = useRef<Map<string, Message>>(new Map());
  const autoScrollFrameRef = useRef<number | null>(null);
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
  // 最近一次收到任意可识别 WS 流事件的时间戳；发送时先设一次初始值，
  // 覆盖"WS 还没收到任何事件"这种起始静默状态。配合下方静默检测判断要不要提示"回复较慢"。
  const lastStreamEventAtRef = useRef<number | null>(null);
  // 本轮实际发送给后端的用户消息原文和选项(含贴盘面等场景要原样带上的字段)，
  // 供"一键重试"在不知道用户是否已经清空输入框的情况下，仍能重新发出同一条消息。
  const lastSentMessageContentRef = useRef<string | null>(null);
  const lastSentMessageOptionsRef = useRef<ChatMessageSendOptions | undefined>(
    undefined,
  );
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

  const commitPendingStreamingMessageUpdates = useCallback(() => {
    const updates = Array.from(pendingStreamingUpdatesRef.current.values());
    pendingStreamingUpdatesRef.current.clear();
    if (updates.length === 0) return;

    setMessages((previous) =>
      mergeStreamingMessageUpdates(previous, updates),
    );
  }, []);

  const flushStreamingMessageUpdates = useCallback(() => {
    if (streamingUpdateTimerRef.current !== null) {
      window.clearTimeout(streamingUpdateTimerRef.current);
      streamingUpdateTimerRef.current = null;
    }
    commitPendingStreamingMessageUpdates();
  }, [commitPendingStreamingMessageUpdates]);

  const queueStreamingMessageUpdate = useCallback(
    (message: Message) => {
      // 一个提交窗口内只保留每条流式消息的最后快照，避免模型 token 频率直接变成 React 提交频率。
      pendingStreamingUpdatesRef.current.set(message.id, message);
      if (streamingUpdateTimerRef.current !== null) return;

      streamingUpdateTimerRef.current = window.setTimeout(() => {
        streamingUpdateTimerRef.current = null;
        commitPendingStreamingMessageUpdates();
      }, STREAMING_UPDATE_INTERVAL_MS);
    },
    [commitPendingStreamingMessageUpdates],
  );

  const resetStreamingMessageRefs = useCallback(() => {
    if (streamingUpdateTimerRef.current !== null) {
      window.clearTimeout(streamingUpdateTimerRef.current);
      streamingUpdateTimerRef.current = null;
    }
    pendingStreamingUpdatesRef.current.clear();
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

  useEffect(() => {
    sessionsRef.current = options.sessions;
  }, [options.sessions]);

  // 把最新的 messages / hasMoreOlder 同步到 ref,供 scroll 事件与翻页回调无闭包读取。
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    hasMoreOlderRef.current = hasMoreOlder;
  }, [hasMoreOlder]);

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

      try {
        // 用当前已展开窗口大小作为 limit:首次加载为一页;用户上滑撑大窗口后,
        // 后台刷新仍能覆盖整窗,避免把已加载历史重新截断回最近一页。
        const requestLimit = loadedWindowSizeRef.current;
        const data = await chatSessionsApi.messages(sessionId, requestLimit);
        if (activeSessionRef.current !== sessionId) {
          return { ok: true, active: false };
        }

        dispatchLoadedSessionMeta({
          type: 'loaded',
          sessionId,
          blocked: Boolean(data.continuation_blocked),
          message: data.continuation_block_message || '',
        });
        databaseProcessingRef.current = data.processing;
        // 仅在前台(切换/刷新)时据返回条数判断是否还有更早消息;
        // 后台轮询不改动该标记,避免大窗口刷新时误判。
        if (!isBackground) {
          dispatchPagination({
            type: 'set-has-more',
            value: data.messages.length >= requestLimit,
          });
        }

        const nextMessages = data.messages.reverse();
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
              ? mergeStreamingTurnMessages(
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
          dispatchRequestStatus({ type: 'set-loading', value: false });
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

  /**
   * 向更早翻页:以当前最早一条消息的 timestamp 作游标拉取上一页,前置插入。
   *
   * 通过 ref 读取重入/可用状态,可安全地由 scroll 事件高频触发。
   */
  const loadOlderMessages = useCallback(async () => {
    const sessionId = activeSessionRef.current;
    if (!sessionId || loadingOlderRef.current || !hasMoreOlderRef.current) {
      return;
    }
    // 列表按时间升序,[0] 即最早一条;以其 timestamp 作 before 游标(后端 timestamp < before)。
    const oldest = messagesRef.current[0];
    if (!oldest) return;

    loadingOlderRef.current = true;
    dispatchPagination({ type: 'older-start' });
    // 记录加载前滚动几何,插入后据此把视口锚回原位(见下方 useLayoutEffect)。
    const scrollElement = scrollRef.current;
    prependAnchorRef.current = scrollElement
      ? { height: scrollElement.scrollHeight, top: scrollElement.scrollTop }
      : null;

    try {
      const data = await chatSessionsApi.messages(
        sessionId,
        MESSAGE_PAGE_SIZE,
        oldest.timestamp,
      );
      if (activeSessionRef.current !== sessionId) {
        prependAnchorRef.current = null;
        return;
      }
      const olderMessages = data.messages.reverse();
      if (olderMessages.length === 0) {
        dispatchPagination({ type: 'set-has-more', value: false });
        prependAnchorRef.current = null;
        return;
      }
      let appendedCount = 0;
      setMessages((previous) => {
        // 按 id 去重,防止游标边界处同 timestamp 消息重复插入;updater 幂等可安全重跑。
        const existingIds = new Set(previous.map((message) => message.id));
        const merged = olderMessages.filter(
          (message) => !existingIds.has(message.id),
        );
        appendedCount = merged.length;
        if (merged.length === 0) return previous;
        return [...merged, ...previous];
      });
      if (appendedCount > 0) {
        // 扩大已展开窗口,使后台刷新覆盖到新加载的历史。
        loadedWindowSizeRef.current += appendedCount;
      } else {
        // 全部被去重(messagesRef 尚未追上)时不锚定,避免无新增却偏移视口。
        prependAnchorRef.current = null;
      }
      // 后端返回满一页即认为仍有更早消息。
      dispatchPagination({
        type: 'set-has-more',
        value: olderMessages.length >= MESSAGE_PAGE_SIZE,
      });
    } catch {
      // 加载失败静默放行,保留 hasMore 允许用户再次上滑重试。
      prependAnchorRef.current = null;
    } finally {
      loadingOlderRef.current = false;
      dispatchPagination({ type: 'older-end' });
    }
  }, []);

  useEffect(() => {
    const previousSelectedSession = previousSelectedSessionRef.current;
    previousSelectedSessionRef.current = options.selectedSession;

    // 切换会话:重置分页窗口与状态,避免沿用上一会话的窗口大小/游标标记。
    loadedWindowSizeRef.current = MESSAGE_PAGE_SIZE;
    loadingOlderRef.current = false;
    prependAnchorRef.current = null;
    dispatchPagination({ type: 'reset' });

    if (options.selectedSession) {
      updateProcessing(false);
      updateAwaitingRefresh(false);
      databaseProcessingRef.current = false;
      dispatchLoadedSessionMeta({ type: 'reset' });
      void loadMessages(options.selectedSession, {
        background:
          sendingRef.current &&
          previousSelectedSession === options.selectedSession,
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
        sessionsRef.current.find((session) => session.id === sessionId)
          ?.account_id ?? 'web';

      queueStreamingMessageUpdate({
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
      });
    },
    [queueStreamingMessageUpdate],
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
        sessionsRef.current.find((session) => session.id === sessionId)
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
    [],
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
        sessionsRef.current.find((session) => session.id === sessionId)
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
    [],
  );

  const appendReconnectNoticeMessage = useCallback(
    (sessionId: string) => {
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
    },
    [],
  );

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

      if (payload.type === 'connected') {
        reconnectAttempt = 0;
        setMessages((previous) => withoutReconnectNoticeMessages(previous));
        return;
      }

      // connected 只是连接层面的握手确认，不代表业务有进展，不计入静默判断——
      // 否则断线重连本身就会不断掩盖"AI 其实一直没真正开始处理"这件事。
      // 走到这里说明是下面这批真正表示业务进展的事件类型之一。
      lastStreamEventAtRef.current = Date.now();

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
            : latestStreamingMessageKeyRef.current,
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
    flushStreamingMessageUpdates,
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
      // 接近顶部且仍有更早消息时,自动加载上一页历史。
      if (
        element.scrollTop <= OLDER_LOAD_THRESHOLD_PX &&
        hasMoreOlderRef.current &&
        !loadingOlderRef.current
      ) {
        void loadOlderMessages();
      }
    };

    handleScroll();
    element.addEventListener('scroll', handleScroll);

    return () => {
      element.removeEventListener('scroll', handleScroll);
    };
  }, [loadOlderMessages]);

  // 上滑加载更早消息后顶部增高,这里把滚动位置补偿回原视口,避免「加载即跳动」。
  // 与下方自动贴底互斥:上滑时用户不在底部,shouldAutoScrollRef 为 false。
  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current;
    if (!anchor || !scrollRef.current) return;
    prependAnchorRef.current = null;
    const element = scrollRef.current;
    // 维持「距底部距离」不变:新 scrollTop = 旧 scrollTop + 本次高度增量。
    element.scrollTop = anchor.top + (element.scrollHeight - anchor.height);
  }, [messages]);

  const scheduleAutoScroll = useCallback(() => {
    if (autoScrollFrameRef.current !== null) return;

    autoScrollFrameRef.current = window.requestAnimationFrame(() => {
      autoScrollFrameRef.current = null;
      const element = scrollRef.current;
      if (!element || !shouldAutoScrollRef.current) return;
      element.scrollTop = element.scrollHeight;
    });
  }, []);

  useLayoutEffect(() => {
    if (!scrollRef.current || !shouldAutoScrollRef.current) return;
    scheduleAutoScroll();
  }, [messages, scheduleAutoScroll]);

  useEffect(() => {
    if (!isPending || !scrollRef.current || !shouldAutoScrollRef.current)
      return;
    scheduleAutoScroll();
  }, [isPending, scheduleAutoScroll]);

  useEffect(
    () => () => {
      if (autoScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(autoScrollFrameRef.current);
      }
    },
    [],
  );

  /**
   * 取消当前请求后重置本地流式状态；不含"是否等待取消接口真正返回"这个决定，
   * 交由调用方处理——stopGenerating 要立即响应用户点击，retrySending 要等
   * 取消真正生效、会话锁已释放，再发新请求，避免和新请求抢锁产生竞态。
   */
  const resetStreamingStateForInterrupt = useCallback(() => {
    sendAbortControllerRef.current?.abort();
    const socket = streamSocketRef.current;
    if (socket) {
      streamSocketRef.current = null;
      socket.close();
    }

    databaseProcessingRef.current = false;
    resetStreamingMessageRefs();
    dispatchRequestStatus({ type: 'set-sending', value: false });
    updateProcessing(false);
    updateAwaitingRefresh(false);
  }, [resetStreamingMessageRefs, updateAwaitingRefresh, updateProcessing]);

  const stopGenerating = useCallback(() => {
    const sessionId = activeSessionRef.current || options.selectedSession;
    if (sessionId) {
      interruptedStreamSessionRef.current = sessionId;
      void chatSessionsApi.cancel(sessionId).catch(() => undefined);
    }

    resetStreamingStateForInterrupt();
    inputRef.current?.focus();
  }, [options.selectedSession, resetStreamingStateForInterrupt]);

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
      if (isPending && !internalOptions?.bypassPendingGuard) return false;
      if (activeContinuationBlocked) return false;
      if (!options.selectedSession && !options.chatAvailable) return false;

      const previousInterruptedSession = interruptedStreamSessionRef.current;
      interruptedStreamSessionRef.current = null;
      if (previousInterruptedSession) {
        setStreamReconnectNonce((value) => value + 1);
      }
      const abortController = new AbortController();
      sendAbortControllerRef.current = abortController;
      dispatchRequestStatus({ type: 'set-sending', value: true });
      shouldAutoScrollRef.current = true;
      // 供"一键重试"复用；初始化静默计时起点，覆盖 WS 还没收到任何事件的起始状态。
      lastSentMessageContentRef.current = content;
      lastSentMessageOptionsRef.current = sendOptions;
      lastStreamEventAtRef.current = Date.now();
      setReplySlow(false);

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
        dispatchRequestStatus({ type: 'set-sending', value: false });
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

  /**
   * "回复较慢"提示里的一键重试：取消当前请求、确认取消真正生效后，
   * 用上一次实际发送的原文重新发一遍，用户不用重新打字。
   */
  const retrySending = useCallback(async () => {
    const sessionId = activeSessionRef.current || options.selectedSession;
    const content = lastSentMessageContentRef.current;
    if (!sessionId || !content) return false;

    interruptedStreamSessionRef.current = sessionId;
    try {
      await chatSessionsApi.cancel(sessionId);
    } catch {
      // cancel 对"没有在途请求"本就幂等成功；真失败大概率是网络抖动，
      // 此时继续重发也是合理兜底，不应阻塞用户重试。
    }
    resetStreamingStateForInterrupt();
    setReplySlow(false);

    // bypassPendingGuard：此刻 sendMessageWithOptions 闭包捕获的 isPending 仍为
    // true（上面 reset 的 setState 尚未触发重渲染），显式放行这次重发，否则会被
    // 入口的在途守卫拦下——净效果就是「取消了在途请求却没重发」，比不点更糟。
    return sendMessageWithOptions(content, lastSentMessageOptionsRef.current, {
      bypassPendingGuard: true,
    });
  }, [
    options.selectedSession,
    resetStreamingStateForInterrupt,
    sendMessageWithOptions,
  ]);

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
