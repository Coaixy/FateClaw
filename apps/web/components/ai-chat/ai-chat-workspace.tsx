'use client';

import {
  Suspense,
  type ClipboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import {
  AlertCircle,
  ArrowDown,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  CircleStop,
  Compass,
  MessageCircle,
  Sparkles,
  Users,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import {
  AiChatComposer,
  shouldSendOnEnter,
} from '@/components/ai-chat/ai-chat-composer';
import { ModelSelector } from '@/components/ai-chat/model-selector';
import { useModelSelection } from '@/features/model-settings/use-model-selection';
import { AiChatMessageList } from '@/components/ai-chat/ai-chat-message-list';
import { OnboardingGuideDialog } from '@/components/ai-chat/onboarding-guide-dialog';
import { PaipanSkillRail } from '@/components/ai-chat/paipan-skill-rail';
import { useOnboardingGuideStatus } from '@/components/ai-chat/use-onboarding-guide-status';
import {
  shouldPromptForPastedBoard,
  type UserPastedBoardInput,
} from '@/features/chat/pasted-board-input';
import { startUserPastedBoardSubmission } from '@/features/chat/pasted-board-submission';
import {
  filterProgressMessages,
  getLatestProgressLabel,
} from '@/features/chat/utils/display';
import { chatSessionsApi, type ChatSession } from '@/features/chat/api';
import { useChatMessages } from '@/features/chat/hooks/use-chat-messages';
import {
  useChatDraft,
  type ChatDraftSubmission,
} from '@/features/chat/hooks/use-chat-draft';
import { SessionContextBar } from '@/components/ai-chat/session-context-bar';
import {
  PENDING_CHAT_INPUT_KEY,
  useChatSessions,
} from '@/features/chat/hooks/use-chat-sessions';
import { useAuth } from '@/features/auth/hooks/use-auth';
import { useBillingSnapshot } from '@/features/billing/hooks/use-billing-snapshot';
import {
  paipanApi,
  type PaipanCatalogItem,
  type PaipanCommitResponse,
} from '@/features/paipan/api';
import { buildLoginHref } from '@/lib/auth-redirect';
import { useI18n } from '@/lib/i18n';
import { buildGuideReturnQuery } from '@/lib/return-to';
import { useToast } from '@/lib/use-toast';

type PaipanSheetMode = 'pre-chat' | 'current-session';
type NewChatStartMode = 'choice' | 'paipan' | 'plain';
type PasteChoiceSelection = {
  readonly start: number;
  readonly end: number;
};
type PastedBoardDraftSource = 'composer' | 'paste' | 'manual';
type ReplyStatus = 'completed' | 'stopped' | 'failed';
const PaipanSheet = dynamic(
  () =>
    import('@/components/ai-chat/paipan-sheet').then(
      (module) => module.PaipanSheet,
    ),
  { ssr: false, loading: () => <ChatSheetLoading /> },
);
const PastedBoardSheet = dynamic(
  () =>
    import('@/components/ai-chat/pasted-board-sheet').then(
      (module) => module.PastedBoardSheet,
    ),
  { ssr: false, loading: () => <ChatSheetLoading /> },
);

function scheduleIdleTask(task: () => void) {
  if (typeof window === 'undefined') {
    return () => {};
  }
  const browserWindow = window as Window &
    typeof globalThis & {
      requestIdleCallback?: (
        callback: () => void,
        options?: { timeout: number },
      ) => number;
      cancelIdleCallback?: (handle: number) => void;
    };

  if (browserWindow.requestIdleCallback) {
    const idleId = browserWindow.requestIdleCallback(() => task(), {
      timeout: 1200,
    });
    return () => browserWindow.cancelIdleCallback?.(idleId);
  }

  const timeoutId = browserWindow.setTimeout(task, 250);
  return () => browserWindow.clearTimeout(timeoutId);
}

// ===== 术数目录状态 =====
// 目录列表与加载态由 AI Chat 统一拉取、成组变化。
type PaipanCatalogState = {
  items: PaipanCatalogItem[];
  loading: boolean;
};

type PaipanCatalogAction =
  | { type: 'load' }
  | { type: 'success'; items: PaipanCatalogItem[] }
  | { type: 'error' };

const INITIAL_PAIPAN_CATALOG_STATE: PaipanCatalogState = {
  items: [],
  loading: false,
};

function paipanCatalogReducer(
  state: PaipanCatalogState,
  action: PaipanCatalogAction,
): PaipanCatalogState {
  switch (action.type) {
    case 'load':
      return { items: [], loading: true };
    case 'success':
      return { items: action.items, loading: false };
    case 'error':
      return { items: [], loading: false };
    default:
      return state;
  }
}

// ===== 排盘弹层开合配置 =====
// 弹层模式、预选术数、是否锁定术数、预选客户 id 总是被同一个打开/关闭动作整体改写。
type PaipanSheetConfigState = {
  mode: PaipanSheetMode | null;
  skill: string | null;
  lockSkill: boolean;
  clientId: string | null;
};

type PaipanSheetConfigAction =
  | { type: 'openPreChat'; skill?: string }
  | { type: 'openCurrentSession'; skill?: string }
  | { type: 'openForClient'; clientId: string }
  | { type: 'close' };

const INITIAL_PAIPAN_SHEET_CONFIG_STATE: PaipanSheetConfigState = {
  mode: null,
  skill: null,
  lockSkill: false,
  clientId: null,
};

function paipanSheetConfigReducer(
  state: PaipanSheetConfigState,
  action: PaipanSheetConfigAction,
): PaipanSheetConfigState {
  switch (action.type) {
    case 'openPreChat':
      // 仅改写模式/术数/锁定，保留既有客户预选（与原 openPreChatPaipan 一致）。
      return {
        ...state,
        mode: 'pre-chat',
        skill: action.skill ?? null,
        lockSkill: Boolean(action.skill),
      };
    case 'openCurrentSession':
      return {
        ...state,
        mode: 'current-session',
        skill: action.skill ?? null,
        lockSkill: Boolean(action.skill),
      };
    case 'openForClient':
      // 客户卡片"发起排盘"：默认八字、不锁定、记录客户 id。
      return {
        mode: 'pre-chat',
        skill: 'bazi-paipan',
        lockSkill: false,
        clientId: action.clientId,
      };
    case 'close':
      return INITIAL_PAIPAN_SHEET_CONFIG_STATE;
    default:
      return state;
  }
}

// ===== 粘贴成盘弹层草稿 =====
// 草稿内容、弹层开合、草稿来源在打开弹层时一起写入；来源决定提交后是否清空输入框。
type PastedBoardState = {
  draft: string;
  sheetOpen: boolean;
  draftSource: PastedBoardDraftSource;
};

type PastedBoardAction =
  | { type: 'open'; draft: string; source: PastedBoardDraftSource }
  | { type: 'close' };

const INITIAL_PASTED_BOARD_STATE: PastedBoardState = {
  draft: '',
  sheetOpen: false,
  draftSource: 'manual',
};

function pastedBoardReducer(
  state: PastedBoardState,
  action: PastedBoardAction,
): PastedBoardState {
  switch (action.type) {
    case 'open':
      return {
        draft: action.draft,
        sheetOpen: true,
        draftSource: action.source,
      };
    case 'close':
      return { ...state, sheetOpen: false };
    default:
      return state;
  }
}

// ===== 粘贴选择气泡 =====
// 用户在输入框粘贴疑似排盘文本时，记录候选文本与原选区，供"作为盘面/作为消息"二选一。
type PasteChoiceState = {
  text: string;
  selection: PasteChoiceSelection | null;
};

type PasteChoiceAction =
  | { type: 'prompt'; text: string; selection: PasteChoiceSelection }
  | { type: 'clear' };

const INITIAL_PASTE_CHOICE_STATE: PasteChoiceState = {
  text: '',
  selection: null,
};

function pasteChoiceReducer(
  state: PasteChoiceState,
  action: PasteChoiceAction,
): PasteChoiceState {
  switch (action.type) {
    case 'prompt':
      return { text: action.text, selection: action.selection };
    case 'clear':
      return INITIAL_PASTE_CHOICE_STATE;
    default:
      return state;
  }
}

export function AiChatWorkspace() {
  return (
    <Suspense
      fallback={
        <div className="min-h-dvh flex items-center justify-center">
          <div className="flex items-center gap-1">
            {[0, 1, 2].map((index) => (
              <div
                key={index}
                className="w-2 h-2 rounded-full bg-primary animate-thinking-dot"
                style={{ animationDelay: `${index * 0.2}s` }}
              />
            ))}
          </div>
        </div>
      }
    >
      <AppShell wide noPadding requireAuth={false}>
        <AiChatWorkspaceContent />
      </AppShell>
    </Suspense>
  );
}

function AiChatWorkspaceContent() {
  const { t } = useI18n();
  const { toast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading: authLoading } = useAuth();
  const { status: billingStatus, loading: billingLoading } =
    useBillingSnapshot();
  const {
    chatAvailable,
    sessions,
    selectedSession,
    selectedSessionRevision,
    setSelectedSession,
    createSession,
    touchSession,
  } = useChatSessions();
  const { input, setInput, takeDraft, restoreDraft, adoptDraft } = useChatDraft(
    { userId: user?.id, sessionId: selectedSession },
  );
  const activeSubmissionRef = useRef<ChatDraftSubmission | null>(null);
  const createSessionWithDraft = useCallback(
    async (onCreated?: (session: ChatSession) => void) => {
      return createSession((session) => {
        onCreated?.(session);
        adoptDraft(session.id, activeSubmissionRef.current ?? undefined);
      });
    },
    [createSession, adoptDraft],
  );
  // 空会话只控制“选择开始方式 / 先排盘 / 直接提问”三种首屏状态；
  // 真正的会话仍在确认盘面或发送首条消息时才创建。
  const [newChatStartMode, setNewChatStartMode] =
    useState<NewChatStartMode>('choice');
  // 排盘弹层开合配置（模式 / 预选术数 / 锁定 / 预选客户 id）合并为单一 reducer。
  const [paipanSheetConfig, dispatchPaipanSheetConfig] = useReducer(
    paipanSheetConfigReducer,
    INITIAL_PAIPAN_SHEET_CONFIG_STATE,
  );
  // 术数目录列表与加载态。
  const [paipanCatalogState, dispatchPaipanCatalog] = useReducer(
    paipanCatalogReducer,
    INITIAL_PAIPAN_CATALOG_STATE,
  );
  // 粘贴成盘弹层草稿（内容 / 开合 / 来源）。
  const [pastedBoardSheet, dispatchPastedBoard] = useReducer(
    pastedBoardReducer,
    INITIAL_PASTED_BOARD_STATE,
  );
  // 输入框粘贴疑似排盘文本时的二选一气泡（候选文本 + 原选区）。
  const [pasteChoice, dispatchPasteChoice] = useReducer(
    pasteChoiceReducer,
    INITIAL_PASTE_CHOICE_STATE,
  );
  const [replyStatus, setReplyStatus] = useState<ReplyStatus | null>(null);
  const previousRunPhaseRef = useRef('idle');

  const chatMessages = useChatMessages({
    chatAvailable,
    selectedSession,
    selectedSessionRevision,
    sessions,
    createSession: createSessionWithDraft,
    touchSession,
  });
  const selectedSessionInfo = sessions.find(
    (entry) => entry.id === selectedSession,
  );
  const modelSelection = useModelSelection({
    userId: user?.id,
    sessionId: selectedSession || undefined,
    session: selectedSessionInfo,
    sending: chatMessages.sending,
    onSessionChange: touchSession,
  });
  const modelControl = chatAvailable ? (
    <ModelSelector
      overview={modelSelection.overview}
      poolKey={modelSelection.poolKey}
      busy={modelSelection.busy || chatMessages.sending}
      error={modelSelection.error}
      onChange={(key) => void modelSelection.change(key)}
      onRetry={() => void modelSelection.refresh()}
    />
  ) : undefined;
  const selectedSessionMessagesLoaded =
    !selectedSession || chatMessages.loadedSessionId === selectedSession;
  const continuationBlocked =
    selectedSessionMessagesLoaded && chatMessages.continuationBlocked;
  const onboardingGuide = useOnboardingGuideStatus({
    enabled: chatAvailable && !authLoading,
  });

  const requestLogin = useCallback(
    (draft?: string) => {
      const pendingText = draft?.trim();
      if (pendingText && typeof window !== 'undefined') {
        window.sessionStorage.setItem(PENDING_CHAT_INPUT_KEY, pendingText);
      }
      router.push(buildLoginHref());
    },
    [router],
  );

  useEffect(() => {
    if (!selectedSession) {
      // revision 能区分连续点击“新建对话”的情况，即使会话 id 一直为空也要回到首屏。
      setNewChatStartMode('choice');
    }
  }, [selectedSession, selectedSessionRevision]);

  useEffect(() => {
    if (!chatAvailable || typeof window === 'undefined') {
      return;
    }

    const pendingText = window.sessionStorage.getItem(PENDING_CHAT_INPUT_KEY);
    if (!pendingText) {
      return;
    }

    window.sessionStorage.removeItem(PENDING_CHAT_INPUT_KEY);
    setInput((current) => current || pendingText);
    setNewChatStartMode('plain');
  }, [chatAvailable]);

  useEffect(() => {
    let cancelled = false;
    dispatchPaipanCatalog({ type: 'load' });

    const cancelIdleTask = scheduleIdleTask(() => {
      if (cancelled) return;

      // 术数目录由 AI Chat 统一加载，避免空态入口和排盘弹层各自重复请求。
      void paipanApi
        .catalog()
        .then((items) => {
          if (cancelled) return;
          // success/error 各自把 loading 落定为 false（原 finally 的职责合并进来）。
          dispatchPaipanCatalog({ type: 'success', items });
        })
        .catch((error) => {
          if (cancelled) return;
          dispatchPaipanCatalog({ type: 'error' });
          toast(
            'error',
            error instanceof Error
              ? error.message
              : t('aiChat.loadPaipanFailed'),
          );
        });
    });

    return () => {
      cancelled = true;
      cancelIdleTask();
    };
  }, [t, toast]);

  const handleSend = useCallback(
    async (overrideText?: string) => {
      const text = (overrideText ?? input).trim();
      if (!text || chatMessages.sending) return;
      if (continuationBlocked) return;
      if (authLoading) return;
      if (!chatAvailable) {
        requestLogin(text);
        return;
      }
      if (modelSelection.blocked) {
        toast('error', modelSelection.error || t('modelChoice.blocked'));
        return;
      }
      const submission = overrideText ? null : takeDraft();
      activeSubmissionRef.current = submission;

      try {
        const sent = await chatMessages.sendMessageWithOptions(text);
        if (!sent && submission) restoreDraft(submission);
      } catch (error) {
        if (submission) restoreDraft(submission);
        toast(
          'error',
          error instanceof Error ? error.message : t('aiChat.sendFailed'),
        );
      } finally {
        if (activeSubmissionRef.current === submission)
          activeSubmissionRef.current = null;
      }
    },
    [
      chatAvailable,
      chatMessages,
      modelSelection,
      continuationBlocked,
      authLoading,
      input,
      requestLogin,
      takeDraft,
      restoreDraft,
      t,
      toast,
    ],
  );

  const handleRetrySending = useCallback(() => {
    void chatMessages.retrySending();
  }, [chatMessages.retrySending]);

  const handleStopGenerating = useCallback(() => {
    void chatMessages.stopGenerating();
  }, [chatMessages]);

  const handleInputChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(event.target.value);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!chatMessages.sending && shouldSendOnEnter(event)) {
      event.preventDefault();
      void handleSend();
    }
  };

  const openPastedBoardSheet = useCallback(
    (content = '', source: PastedBoardDraftSource = 'manual') => {
      dispatchPastedBoard({ type: 'open', draft: content, source });
      dispatchPasteChoice({ type: 'clear' });
    },
    [],
  );

  const closePastedBoardSheet = useCallback(() => {
    dispatchPastedBoard({ type: 'close' });
  }, []);

  const handleComposerPaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      if (chatMessages.sending || continuationBlocked || !chatAvailable) {
        return;
      }

      const text = event.clipboardData.getData('text');
      if (!shouldPromptForPastedBoard(text)) return;

      event.preventDefault();
      dispatchPasteChoice({
        type: 'prompt',
        text,
        selection: {
          start: event.currentTarget.selectionStart,
          end: event.currentTarget.selectionEnd,
        },
      });
    },
    [chatAvailable, continuationBlocked, chatMessages.sending],
  );

  const handleUsePasteAsBoard = useCallback(() => {
    // openPastedBoardSheet 内部已清空气泡，这里再清一次保持与原实现一致。
    openPastedBoardSheet(pasteChoice.text, 'paste');
    dispatchPasteChoice({ type: 'clear' });
  }, [openPastedBoardSheet, pasteChoice.text]);

  const handleKeepPasteAsMessage = useCallback(() => {
    if (!pasteChoice.text) return;
    setInput((previous) => {
      if (
        pasteChoice.selection &&
        pasteChoice.selection.start >= 0 &&
        pasteChoice.selection.end >= pasteChoice.selection.start &&
        pasteChoice.selection.end <= previous.length
      ) {
        const beforeSelection = previous.slice(0, pasteChoice.selection.start);
        const afterSelection = previous.slice(pasteChoice.selection.end);
        return `${beforeSelection}${pasteChoice.text}${afterSelection}`;
      }

      const separator = previous && !previous.endsWith('\n') ? '\n' : '';
      return `${previous}${separator}${pasteChoice.text}`;
    });
    dispatchPasteChoice({ type: 'clear' });
  }, [pasteChoice.selection, pasteChoice.text]);

  const handlePastedBoardSubmit = useCallback(
    (pastedBoard: UserPastedBoardInput) => {
      if (authLoading) {
        return;
      }

      if (!chatAvailable) {
        requestLogin(pastedBoard.content);
        return;
      }
      if (continuationBlocked) {
        return;
      }

      if (chatMessages.sending) {
        toast('error', t('aiChat.previousMessageProcessing'));
        return;
      }
      const submission =
        pastedBoardSheet.draftSource === 'composer' ? takeDraft() : null;
      activeSubmissionRef.current = submission;
      startUserPastedBoardSubmission({
        pastedBoard,
        sendMessage: async (content, options) => {
          try {
            const sent = await chatMessages.sendMessageWithOptions(
              content,
              options,
            );
            if (!sent && submission) restoreDraft(submission);
            return sent;
          } catch (error) {
            if (submission) restoreDraft(submission);
            throw error;
          } finally {
            if (activeSubmissionRef.current === submission)
              activeSubmissionRef.current = null;
          }
        },
        closeSheet: () => dispatchPastedBoard({ type: 'close' }),
        onSendFailure: () => {
          toast('error', t('aiChat.boardSendFailed'));
        },
      });
    },
    [
      authLoading,
      chatAvailable,
      continuationBlocked,
      chatMessages.sendMessageWithOptions,
      chatMessages.sending,
      pastedBoardSheet.draftSource,
      takeDraft,
      restoreDraft,
      requestLogin,
      t,
      toast,
    ],
  );

  const displayMessages = useMemo(
    () => filterProgressMessages(chatMessages.messages),
    [chatMessages.messages],
  );
  const progressLabel = chatMessages.sending
    ? getLatestProgressLabel(chatMessages.messages, t)
    : null;
  const billingStatusReady = Boolean(user && !billingLoading && billingStatus);
  const billingArrears = Boolean(
    billingStatusReady && billingStatus && billingStatus.available_coins < 0,
  );
  const latestMessageNotice =
    selectedSession &&
    modelSelection.poolKey !== 'benefit' &&
    displayMessages.length > 0 &&
    billingStatusReady
      ? billingArrears
        ? 'arrears'
        : null
      : null;
  const switchingSession =
    Boolean(selectedSession) &&
    chatMessages.loading &&
    chatMessages.loadedSessionId !== selectedSession &&
    !chatMessages.sending;
  const showCenteredComposer =
    !selectedSession ||
    (!chatMessages.loading &&
      !chatMessages.sending &&
      displayMessages.length === 0);

  useEffect(() => {
    const phase = chatMessages.run.phase;
    const previous = previousRunPhaseRef.current;
    previousRunPhaseRef.current = phase;
    if (
      phase === 'idle' ||
      phase === 'queued' ||
      phase === 'running' ||
      phase === 'syncing' ||
      phase === 'stopping'
    ) {
      setReplyStatus(null);
    } else if (previous !== 'idle' && previous !== phase) {
      setReplyStatus(phase);
    }
  }, [chatMessages.run.phase]);

  useEffect(() => {
    previousRunPhaseRef.current = 'idle';
    setReplyStatus(null);
  }, [selectedSession]);

  useEffect(() => {
    if (!replyStatus) return;

    const timeoutId = window.setTimeout(() => {
      setReplyStatus(null);
    }, 2400);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [replyStatus]);

  const handlePaipanCommitted = useCallback(
    async (result: PaipanCommitResponse) => {
      touchSession(result.session.id, result.session);
      if (result.session.id === selectedSession) {
        await chatMessages.refreshMessages();
        return;
      }
      setSelectedSession(result.session.id);
    },
    [
      chatMessages,
      selectedSession,
      setSelectedSession,
      touchSession,
    ],
  );

  const openPreChatPaipan = useCallback(
    (skill?: string) => {
      if (authLoading) {
        return;
      }

      setNewChatStartMode('paipan');
      dispatchPaipanSheetConfig({ type: 'openPreChat', skill });
    },
    [authLoading],
  );

  const openSkillMarket = useCallback(() => {
    router.push('/discover');
  }, [router]);

  const openSkillMarketFromGuide = useCallback(() => {
    onboardingGuide.saveStep('skill');
    router.push(`/discover?${buildGuideReturnQuery('/ai-chat')}`);
  }, [onboardingGuide, router]);

  const retryOnboardingGuide = useCallback(() => {
    void onboardingGuide.refresh();
  }, [onboardingGuide]);

  const openCurrentSessionPaipan = useCallback(
    (skill?: string) => {
      if (authLoading) {
        return;
      }
      if (continuationBlocked) {
        return;
      }

      dispatchPaipanSheetConfig({ type: 'openCurrentSession', skill });
    },
    [authLoading, continuationBlocked],
  );

  const handleClosePaipanSheet = useCallback(() => {
    if (paipanSheetConfig.mode === 'pre-chat' && !selectedSession) {
      setNewChatStartMode('choice');
    }
    dispatchPaipanSheetConfig({ type: 'close' });
  }, [paipanSheetConfig.mode, selectedSession]);

  // 客户卡片"发起排盘"会带 ?client= 进入：自动打开排盘并预选该客户（默认八字，可改）。
  const clientParamHandledRef = useRef(false);
  useEffect(() => {
    if (clientParamHandledRef.current || authLoading) {
      return;
    }
    const clientId = searchParams.get('client');
    if (!clientId) {
      return;
    }
    clientParamHandledRef.current = true;
    setNewChatStartMode('paipan');
    dispatchPaipanSheetConfig({ type: 'openForClient', clientId });
    // 清掉 URL 上的 client 参数，避免刷新或重渲染重复触发。
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.delete('client');
      window.history.replaceState(null, '', `${url.pathname}${url.search}`);
    }
  }, [authLoading, searchParams]);

  const handleOpenComposerPastedBoard = useCallback(() => {
    if (authLoading) {
      return;
    }

    if (!chatAvailable) {
      requestLogin(input);
      return;
    }
    if (continuationBlocked) {
      return;
    }

    openPastedBoardSheet(input, 'composer');
  }, [
    authLoading,
    chatAvailable,
    continuationBlocked,
    input,
    openPastedBoardSheet,
    requestLogin,
  ]);
  const pastedBoardDisabled =
    authLoading || chatMessages.sending || continuationBlocked;
  const paipanActionTitle = t('aiChat.toolbar.jointPaipan');
  const composer = (
    <AiChatComposer
      inputRef={chatMessages.inputRef}
      input={input}
      sending={chatMessages.sending}
      stopping={chatMessages.stopping}
      disabled={continuationBlocked}
      disabledMessage=""
      selectedSession={selectedSession}
      modelControl={modelControl}
      sendDisabled={modelSelection.blocked}
      paipanAction={
        selectedSession
          ? {
              loading: paipanCatalogState.loading,
              disabled:
                authLoading ||
                chatMessages.sending ||
                continuationBlocked ||
                paipanCatalogState.loading ||
                paipanCatalogState.items.length === 0,
              title: paipanActionTitle,
              onOpen: () => openCurrentSessionPaipan(),
            }
          : undefined
      }
      pasteChoiceOpen={Boolean(pasteChoice.text)}
      pasteChoicePreview={pasteChoice.text}
      onInputChange={handleInputChange}
      onPaste={handleComposerPaste}
      onKeyDown={handleKeyDown}
      onUsePasteAsBoard={handleUsePasteAsBoard}
      onKeepPasteAsMessage={handleKeepPasteAsMessage}
      onDismissPasteChoice={() => {
        dispatchPasteChoice({ type: 'clear' });
      }}
      onSend={() => void handleSend()}
      onStop={handleStopGenerating}
    />
  );

  const selectedSessionCenteredComposer = (
    <div className="space-y-2.5">
      {composer}
      {onboardingGuide.shouldShowContinueEntry && (
        <OnboardingGuideEntry onOpen={onboardingGuide.openGuide} />
      )}
    </div>
  );
  const newChatCenteredContent =
    newChatStartMode === 'choice' ? (
      <NewChatStartChoice
        onChoosePaipan={() => setNewChatStartMode('paipan')}
        onChoosePlain={() => setNewChatStartMode('plain')}
      />
    ) : newChatStartMode === 'paipan' ? (
      <div className="space-y-2.5">
        <NewChatBackButton onBack={() => setNewChatStartMode('choice')} />
        <PaipanSkillRail
          catalog={paipanCatalogState.items}
          loading={paipanCatalogState.loading}
          disabled={authLoading || chatMessages.sending}
          pastedBoardDisabled={pastedBoardDisabled}
          onSelectSkill={(skill) => openPreChatPaipan(skill)}
          onOpenSkillMarket={openSkillMarket}
          onOpenPastedBoard={handleOpenComposerPastedBoard}
        />
      </div>
    ) : (
      <div className="space-y-2.5">
        <NewChatBackButton onBack={() => setNewChatStartMode('choice')} />
        {composer}
        {onboardingGuide.shouldShowContinueEntry && (
          <OnboardingGuideEntry onOpen={onboardingGuide.openGuide} />
        )}
      </div>
    );
  const centeredContent = selectedSession
    ? selectedSessionCenteredComposer
    : newChatCenteredContent;
  const emptyStateTitle = selectedSession
    ? t('aiChat.empty.defaultTitle')
    : newChatStartMode === 'choice'
      ? t('aiChat.start.title')
      : newChatStartMode === 'paipan'
        ? t('aiChat.start.paipanStepTitle')
        : t('aiChat.start.plainStepTitle');
  const emptyStateDescription = selectedSession
    ? t('aiChat.empty.defaultDescription')
    : newChatStartMode === 'choice'
      ? t('aiChat.start.description')
      : newChatStartMode === 'paipan'
        ? t('aiChat.start.paipanStepDescription')
        : t('aiChat.start.plainStepDescription');
  // 新建对话首屏已有明确的分支说明，不再叠加旧版“可直接问或手动排盘”提示。
  const emptyStateHint = selectedSession ? undefined : '';
  const emptyStateFrameClassName = !selectedSession
    ? newChatStartMode === 'choice'
      ? 'justify-center pb-12'
      : 'justify-start pb-8 pt-6 lg:pt-8'
    : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col pt-1.5 lg:pt-0">
      {selectedSession && (
        <SessionContextBar
          clientId={selectedSessionInfo?.client_id}
        />
      )}
      {chatMessages.historyError && (
        <div
          role="alert"
          className="mx-auto mb-2 flex w-full max-w-3xl items-center justify-between gap-2 rounded-lg border border-error/25 bg-error/5 px-3 py-2 text-[12px] text-error"
        >
          <span>{chatMessages.historyError}</span>
          <button
            type="button"
            onClick={() => void chatMessages.refreshMessages()}
            className="min-h-9 shrink-0 rounded-md px-2 hover:bg-error/10"
          >
            {t('aiChat.reading.retryHistory')}
          </button>
        </div>
      )}
      <div
        ref={chatMessages.scrollRef}
        className={`relative min-h-0 flex-1 overflow-y-auto overscroll-contain py-3 lg:py-5 ${
          chatMessages.sending ? '' : 'scroll-smooth'
        }`}
      >
        <AiChatMessageList
          messages={displayMessages}
          loading={chatMessages.loading}
          sending={chatMessages.sending}
          progressLabel={progressLabel}
          replySlow={chatMessages.replySlow}
          onRetry={handleRetrySending}
          selectedSession={selectedSession}
          switchingSession={switchingSession}
          loadingOlder={chatMessages.loadingOlder}
          showCenteredComposer={showCenteredComposer}
          latestMessageNotice={latestMessageNotice}
          composer={showCenteredComposer ? centeredContent : null}
          emptyStateTitle={emptyStateTitle}
          emptyStateDescription={emptyStateDescription}
          emptyStateHint={emptyStateHint}
          emptyStateFrameClassName={emptyStateFrameClassName}
          emptyStateMaxWidthClassName="max-w-xl"
        />
        {!showCenteredComposer && replyStatus && (
          <AiChatFloatingStatus status={replyStatus} />
        )}
      </div>

      {!showCenteredComposer && !chatMessages.followingLatest && (
        <div className="flex shrink-0 justify-center py-1">
          <button
            type="button"
            onClick={chatMessages.scrollToLatest}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-hairline bg-surface-card px-3 text-[12px] text-ink shadow-sm hover:border-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
          >
            <ArrowDown size={13} />
            {t(
              chatMessages.sending
                ? 'aiChat.reading.newContent'
                : 'aiChat.reading.latest',
            )}
          </button>
        </div>
      )}

      {!showCenteredComposer && (
        <div className="shrink-0 pt-1.5 pb-1 safe-bottom">
          <div className="max-w-3xl mx-auto px-2.5 sm:px-3">
            {(chatMessages.sending || chatMessages.run.error) && (
              <p
                role="status"
                className={`mb-1.5 text-center text-[12px] ${chatMessages.run.error ? 'text-error' : 'text-muted'}`}
              >
                {chatMessages.run.error ||
                  t(`aiChat.run.${chatMessages.run.phase}`)}
              </p>
            )}
            {composer}
            <p className="mt-1.5 flex items-center justify-center gap-1 text-center text-[10px] text-muted/50 select-none">
              <Sparkles size={10} strokeWidth={1.8} aria-hidden="true" />
              <span>{t('aiChat.composer.aiDisclaimer')}</span>
            </p>
          </div>
        </div>
      )}

      {paipanSheetConfig.mode !== null && (
        <PaipanSheet
          open={paipanSheetConfig.mode !== null}
          mode={paipanSheetConfig.mode ?? 'pre-chat'}
          catalog={paipanCatalogState.items}
          catalogLoading={paipanCatalogState.loading}
          sessionId={selectedSession || undefined}
          initialSkill={paipanSheetConfig.skill}
          initialClientId={paipanSheetConfig.clientId}
          lockSkill={paipanSheetConfig.lockSkill}
          canCommit={
            chatAvailable &&
            (paipanSheetConfig.mode !== 'current-session' ||
              !continuationBlocked)
          }
          onClose={handleClosePaipanSheet}
          onAuthRequired={() => requestLogin(input)}
          onCommitted={handlePaipanCommitted}
        />
      )}

      {pastedBoardSheet.sheetOpen && (
        <PastedBoardSheet
          open={pastedBoardSheet.sheetOpen}
          initialContent={pastedBoardSheet.draft}
          catalog={paipanCatalogState.items}
          onClose={closePastedBoardSheet}
          onSubmit={handlePastedBoardSubmit}
          modelControl={modelControl}
          submitBlockedMessage={
            modelSelection.blocked
              ? modelSelection.error || t('modelChoice.blocked')
              : ''
          }
        />
      )}

      <OnboardingGuideDialog
        open={onboardingGuide.open}
        step={onboardingGuide.step}
        modelReady={onboardingGuide.modelReady}
        modelMembershipRequired={onboardingGuide.modelMembershipRequired}
        skillReady={onboardingGuide.skillReady}
        modelLoading={onboardingGuide.modelLoading}
        skillLoading={onboardingGuide.skillLoading}
        modelError={onboardingGuide.modelError}
        skillError={onboardingGuide.skillError}
        hasAnyInstalledSkill={onboardingGuide.hasAnyInstalledSkill}
        onClose={onboardingGuide.dismissGuide}
        onSaveStep={onboardingGuide.saveStep}
        onRetry={retryOnboardingGuide}
        onOpenSkillMarket={openSkillMarketFromGuide}
        onComplete={onboardingGuide.completeGuide}
      />
    </div>
  );
}

/**
 * 新建对话的首步选择，只决定是否先排盘，不提前创建会话。
 *
 * 卡片下方附技能开发 / 客户档案入口：这两个低频管理页从侧栏移入此处，
 * 让侧栏保持「新建对话 + 最近对话」的单一焦点。
 *
 * @param props.onChoosePaipan 进入术数选择步骤。
 * @param props.onChoosePlain 进入普通问题输入步骤。
 * @returns 两个互斥开始方式的操作区。
 */
function NewChatStartChoice({
  onChoosePaipan,
  onChoosePlain,
}: {
  onChoosePaipan: () => void;
  onChoosePlain: () => void;
}) {
  const { t } = useI18n();

  return (
    <div className="grid w-full gap-2.5">
      <button
        type="button"
        onClick={onChoosePaipan}
        className="btn-tactile group flex min-h-[72px] w-full items-center gap-3 rounded-lg border border-primary/25 bg-primary/6 px-4 py-3 text-left text-ink transition-all hover:border-primary/40 hover:bg-primary/9 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary">
          <Compass size={19} strokeWidth={1.9} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-semibold">
            {t('aiChat.start.paipan')}
          </span>
          <span className="mt-0.5 block text-[11px] leading-relaxed text-muted">
            {t('aiChat.start.paipanDescription')}
          </span>
        </span>
        <ChevronRight
          size={16}
          className="shrink-0 text-primary/60 transition-transform group-hover:translate-x-0.5"
        />
      </button>

      <button
        type="button"
        onClick={onChoosePlain}
        className="btn-tactile group flex min-h-[72px] w-full items-center gap-3 rounded-lg border border-hairline bg-surface-raised px-4 py-3 text-left text-ink transition-all hover:border-primary/35 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <MessageCircle size={18} strokeWidth={1.9} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-semibold">
            {t('aiChat.start.plain')}
          </span>
          <span className="mt-0.5 block text-[11px] leading-relaxed text-muted">
            {t('aiChat.start.plainDescription')}
          </span>
        </span>
        <ChevronRight
          size={16}
          className="shrink-0 text-primary/60 transition-transform group-hover:translate-x-0.5"
        />
      </button>

      {/* 次级入口：与主卡片同结构（图标色块+标题+副标题）的双列卡片，
          高度略矮（64px vs 72px）保留层级差。低频管理页从侧栏移入此处。 */}
      <div className="mt-1 grid grid-cols-2 gap-2.5">
        <Link
          href="/studio"
          className="btn-tactile group flex min-h-[64px] items-center gap-3 rounded-lg border border-hairline bg-surface-raised px-3.5 py-3 text-left text-ink transition-all hover:border-primary/35 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35"
          aria-label={t('hub.studio')}
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Sparkles size={16} strokeWidth={1.9} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-semibold">
              {t('hub.studio')}
            </span>
            <span className="mt-0.5 block truncate text-[11px] leading-snug text-muted">
              {t('hub.studioDescription')}
            </span>
          </span>
        </Link>
        <Link
          href="/clients"
          className="btn-tactile group flex min-h-[64px] items-center gap-3 rounded-lg border border-hairline bg-surface-raised px-3.5 py-3 text-left text-ink transition-all hover:border-primary/35 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35"
          aria-label={t('hub.clients')}
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Users size={16} strokeWidth={1.9} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-semibold">
              {t('hub.clients')}
            </span>
            <span className="mt-0.5 block truncate text-[11px] leading-snug text-muted">
              {t('hub.clientsDescription')}
            </span>
          </span>
        </Link>
      </div>
    </div>
  );
}

/**
 * 空会话子步骤的返回操作，回到“是否排盘”的首步选择。
 *
 * @param props.onBack 返回回调。
 * @returns 紧凑返回按钮。
 */
function NewChatBackButton({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();

  return (
    <button
      type="button"
      onClick={onBack}
      className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium text-muted transition-colors hover:bg-surface-soft hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35"
    >
      <ArrowLeft size={14} strokeWidth={1.9} />
      <span>{t('aiChat.start.back')}</span>
    </button>
  );
}

function AiChatFloatingStatus({ status }: { status: ReplyStatus }) {
  const { t } = useI18n();
  const statusLabel =
    status === 'completed'
      ? t('aiChat.home.answerCompleted')
      : status === 'failed'
        ? t('aiChat.run.failed')
        : t('aiChat.home.outputStopped');
  const StatusIcon =
    status === 'completed'
      ? CheckCircle2
      : status === 'failed'
        ? AlertCircle
        : CircleStop;

  return (
    <div className="pointer-events-none sticky bottom-2 z-10 mt-2 flex justify-center px-3">
      <span className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-hairline bg-surface-card/95 px-2.5 text-[11px] text-muted shadow-sm backdrop-blur transition-colors">
        <StatusIcon size={12} />
        <span>{statusLabel}</span>
      </span>
    </div>
  );
}

function OnboardingGuideEntry({ onOpen }: { onOpen: () => void }) {
  const { t } = useI18n();

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center justify-between gap-3 rounded-xl border border-primary/20 bg-primary/8 px-3 py-2.5 text-left transition-colors hover:border-primary/35 hover:bg-primary/12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35"
    >
      <span className="flex min-w-0 items-center gap-2">
        <Sparkles size={14} className="shrink-0 text-primary" />
        <span className="min-w-0">
          <span className="block text-[12px] font-semibold text-ink">
            {t('aiChat.guideEntry.title')}
          </span>
          <span className="block truncate text-[10px] text-muted">
            {t('aiChat.guideEntry.description')}
          </span>
        </span>
      </span>
      <ChevronRight size={14} className="shrink-0 text-primary" />
    </button>
  );
}

function ChatSheetLoading() {
  const { t } = useI18n();
  return (
    <div
      role="status"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/15 backdrop-blur-sm"
    >
      <div className="rounded-xl border border-hairline bg-surface-raised px-5 py-4 text-sm text-muted shadow-lg">
        {t('common.loading')}
      </div>
    </div>
  );
}
