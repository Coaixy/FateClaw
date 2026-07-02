'use client';

import {
  Suspense,
  type ClipboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import {
  Bot,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Loader2,
  Sparkles,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { AnnouncementBanner } from '@/components/announcements/announcement-banner';
import { AiChatComposer } from '@/components/ai-chat/ai-chat-composer';
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
import { chatSessionsApi } from '@/features/chat/api';
import { useChatMessages } from '@/features/chat/hooks/use-chat-messages';
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
import {
  modelSettingsApi,
  type ModelSettingsOverview,
  type ModelThinkingLevel,
  type OfficialModel,
} from '@/features/model-settings/api';
import { buildLoginHref } from '@/lib/auth-redirect';
import { useI18n } from '@/lib/i18n';
import { buildGuideReturnQuery } from '@/lib/return-to';
import { useToast } from '@/lib/use-toast';

type PaipanSheetMode = 'pre-chat' | 'current-session';
type PasteChoiceSelection = {
  readonly start: number;
  readonly end: number;
};
type PastedBoardDraftSource = 'composer' | 'paste' | 'manual';
type ReplyStatus = 'completed' | 'interrupted';
type ModelToolbarBusy = '' | 'model' | 'thinking';
const DEFAULT_THINKING_LEVEL: ModelThinkingLevel = 'medium';
const THINKING_LEVEL_OPTIONS: Array<{
  value: ModelThinkingLevel;
  labelKey: string;
}> = [
  { value: 'off', labelKey: 'aiChat.thinkingLevels.off' },
  { value: 'minimal', labelKey: 'aiChat.thinkingLevels.minimal' },
  { value: 'low', labelKey: 'aiChat.thinkingLevels.low' },
  { value: 'medium', labelKey: 'aiChat.thinkingLevels.medium' },
  { value: 'high', labelKey: 'aiChat.thinkingLevels.high' },
  { value: 'xhigh', labelKey: 'aiChat.thinkingLevels.xhigh' },
];
const PaipanSheet = dynamic(
  () =>
    import('@/components/ai-chat/paipan-sheet').then(
      (module) => module.PaipanSheet,
    ),
  { ssr: false, loading: () => null },
);
const PastedBoardSheet = dynamic(
  () =>
    import('@/components/ai-chat/pasted-board-sheet').then(
      (module) => module.PastedBoardSheet,
    ),
  { ssr: false, loading: () => null },
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

function getAvailableOfficialModels(
  overview: ModelSettingsOverview | null,
): OfficialModel[] {
  return (
    overview?.official_models.filter(
      (model) => model.enabled && model.has_secret,
    ) ?? []
  );
}

function resolveToolbarThinkingLevel(
  overview: ModelSettingsOverview | null,
): ModelThinkingLevel {
  return (
    overview?.selection?.thinking_level ??
    overview?.default_thinking_level ??
    DEFAULT_THINKING_LEVEL
  );
}

function findSelectedOfficialModel(
  overview: ModelSettingsOverview | null,
): OfficialModel | null {
  if (overview?.selection?.source !== 'official') {
    return null;
  }
  return (
    getAvailableOfficialModels(overview).find(
      (model) => model.id === overview.selection?.official_model_id,
    ) ?? null
  );
}

// ===== 模型设置工具条状态 =====
// 模型总览、加载态、错误信息与工具条忙碌标记在加载/切换模型时总是成组变化，
// 拆成多个 useState 会触发级联渲染、也让加载生命周期难以追踪，故合并为一个 reducer。
type ModelSettingsState = {
  overview: ModelSettingsOverview | null;
  loading: boolean;
  error: string;
  toolbarBusy: ModelToolbarBusy;
};

type ModelSettingsAction =
  | { type: 'loadStart' }
  | { type: 'loadSuccess'; overview: ModelSettingsOverview }
  | { type: 'loadError'; error: string }
  | { type: 'setToolbarBusy'; value: ModelToolbarBusy }
  | { type: 'reset' };

const INITIAL_MODEL_SETTINGS_STATE: ModelSettingsState = {
  overview: null,
  loading: false,
  error: '',
  toolbarBusy: '',
};

function modelSettingsReducer(
  state: ModelSettingsState,
  action: ModelSettingsAction,
): ModelSettingsState {
  switch (action.type) {
    case 'loadStart':
      // 仅切到加载中并清空旧错误，工具条忙碌标记保持不变（与原始 setState 一致）。
      return { ...state, loading: true, error: '' };
    case 'loadSuccess':
      return { ...state, overview: action.overview, loading: false };
    case 'loadError':
      return { ...state, overview: null, loading: false, error: action.error };
    case 'setToolbarBusy':
      return { ...state, toolbarBusy: action.value };
    case 'reset':
      return INITIAL_MODEL_SETTINGS_STATE;
    default:
      return state;
  }
}

// ===== 术数目录状态 =====
// 目录列表与加载态由工作台统一拉取、成组变化。
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
  const [input, setInput] = useState('');
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
  // 模型设置工具条状态（总览 / 加载 / 错误 / 忙碌标记）。
  const [modelSettings, dispatchModelSettings] = useReducer(
    modelSettingsReducer,
    INITIAL_MODEL_SETTINGS_STATE,
  );
  const wasSendingRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const modelSettingsRequestIdRef = useRef(0);

  const chatMessages = useChatMessages({
    chatAvailable,
    selectedSession,
    selectedSessionRevision,
    sessions,
    createSession,
    touchSession,
  });
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
    if (!chatAvailable || typeof window === 'undefined') {
      return;
    }

    const pendingText = window.sessionStorage.getItem(PENDING_CHAT_INPUT_KEY);
    if (!pendingText) {
      return;
    }

    window.sessionStorage.removeItem(PENDING_CHAT_INPUT_KEY);
    setInput((current) => current || pendingText);
  }, [chatAvailable]);

  const loadModelSettings = useCallback(async () => {
    if (!chatAvailable || authLoading) {
      return;
    }

    const requestId = modelSettingsRequestIdRef.current + 1;
    modelSettingsRequestIdRef.current = requestId;
    dispatchModelSettings({ type: 'loadStart' });

    try {
      const data = await modelSettingsApi.overview();
      if (modelSettingsRequestIdRef.current !== requestId) return;
      // 加载完成时一并落定 loading=false（旧实现由 finally 的 requestId 守卫完成，
      // 这里因前置 return 守卫等价：仅当请求未过期才 dispatch）。
      dispatchModelSettings({ type: 'loadSuccess', overview: data });
    } catch (error) {
      if (modelSettingsRequestIdRef.current !== requestId) return;
      dispatchModelSettings({
        type: 'loadError',
        error:
          error instanceof Error
            ? error.message
            : t('aiChat.loadModelSettingsFailed'),
      });
    }
  }, [authLoading, chatAvailable, t]);

  useEffect(() => {
    if (!chatAvailable || authLoading) {
      modelSettingsRequestIdRef.current += 1;
      dispatchModelSettings({ type: 'reset' });
      return;
    }

    void loadModelSettings();
  }, [authLoading, chatAvailable, loadModelSettings]);

  useEffect(() => {
    let cancelled = false;
    dispatchPaipanCatalog({ type: 'load' });

    const cancelIdleTask = scheduleIdleTask(() => {
      if (cancelled) return;

      // 术数目录由工作台统一加载，避免空态入口和排盘弹层各自重复请求。
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
      if (!overrideText) {
        setInput('');
      }

      try {
        await chatMessages.sendMessageWithOptions(text);
      } catch (error) {
        toast(
          'error',
          error instanceof Error ? error.message : t('aiChat.sendFailed'),
        );
      }
    },
    [
      chatAvailable,
      chatMessages,
      continuationBlocked,
      authLoading,
      input,
      requestLogin,
      t,
      toast,
    ],
  );

  const handleStopGenerating = useCallback(() => {
    stopRequestedRef.current = true;
    chatMessages.stopGenerating();
  }, [chatMessages]);

  const handleInputChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(event.target.value);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
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
      startUserPastedBoardSubmission({
        pastedBoard,
        sendMessage: chatMessages.sendMessageWithOptions,
        closeSheet: () => dispatchPastedBoard({ type: 'close' }),
        clearComposerInput:
          pastedBoardSheet.draftSource === 'composer'
            ? () => setInput('')
            : undefined,
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
      requestLogin,
      t,
      toast,
    ],
  );

  const displayMessages = filterProgressMessages(chatMessages.messages);
  const progressLabel = chatMessages.sending
    ? getLatestProgressLabel(chatMessages.messages, t)
    : null;
  const billingStatusReady = Boolean(user && !billingLoading && billingStatus);
  const billingArrears = Boolean(
    billingStatusReady && billingStatus && billingStatus.available_coins < 0,
  );
  const latestMessageNotice =
    selectedSession && displayMessages.length > 0 && billingStatusReady
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
    if (chatMessages.sending) {
      wasSendingRef.current = true;
      setReplyStatus(null);
      return;
    }

    if (wasSendingRef.current) {
      wasSendingRef.current = false;
      setReplyStatus(stopRequestedRef.current ? 'interrupted' : 'completed');
      stopRequestedRef.current = false;
    }
  }, [chatMessages.sending]);

  useEffect(() => {
    wasSendingRef.current = false;
    stopRequestedRef.current = false;
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
    [chatMessages, selectedSession, setSelectedSession, touchSession],
  );

  const openPreChatPaipan = useCallback(
    (skill?: string) => {
      if (authLoading) {
        return;
      }

      dispatchPaipanSheetConfig({ type: 'openPreChat', skill });
    },
    [authLoading],
  );

  const openSkillMarket = useCallback(() => {
    router.push('/discover');
  }, [router]);

  const selectOfficialModel = useCallback(
    async (officialModelId: string) => {
      if (!modelSettings.overview || modelSettings.toolbarBusy || !officialModelId) {
        return;
      }

      const officialModels = getAvailableOfficialModels(modelSettings.overview);
      const nextModel = officialModels.find(
        (model) => model.id === officialModelId,
      );
      if (!nextModel) {
        toast('error', t('aiChat.onlyAvailableOfficialModel'));
        return;
      }

      if (
        modelSettings.overview.selection?.source === 'official' &&
        modelSettings.overview.selection.official_model_id === nextModel.id
      ) {
        return;
      }

      const thinkingLevel = resolveToolbarThinkingLevel(modelSettings.overview);

      dispatchModelSettings({ type: 'setToolbarBusy', value: 'model' });
      try {
        await modelSettingsApi.select({
          source: 'official',
          official_model_id: nextModel.id,
          thinking_level: thinkingLevel,
        });
        await loadModelSettings();
        void onboardingGuide.refresh();
      } catch (error) {
        toast(
          'error',
          error instanceof Error
            ? error.message
            : t('aiChat.switchModelFailed'),
        );
      } finally {
        dispatchModelSettings({ type: 'setToolbarBusy', value: '' });
      }
    },
    [
      loadModelSettings,
      modelSettings.overview,
      modelSettings.toolbarBusy,
      onboardingGuide,
      t,
      toast,
    ],
  );

  const selectThinkingLevel = useCallback(
    async (nextThinkingLevel: ModelThinkingLevel) => {
      if (
        !modelSettings.overview ||
        modelSettings.toolbarBusy ||
        !modelSettings.overview.selection
      ) {
        return;
      }

      if (
        nextThinkingLevel === resolveToolbarThinkingLevel(modelSettings.overview)
      ) {
        return;
      }

      const selectedOfficial = findSelectedOfficialModel(modelSettings.overview);
      const fallbackOfficial = getAvailableOfficialModels(
        modelSettings.overview,
      )[0];
      const officialModelId =
        modelSettings.overview.selection.source === 'official'
          ? (selectedOfficial?.id ?? fallbackOfficial?.id ?? null)
          : null;

      if (
        modelSettings.overview.selection.source === 'official' &&
        !officialModelId
      ) {
        toast('error', t('aiChat.noAvailableOfficialModel'));
        return;
      }

      dispatchModelSettings({ type: 'setToolbarBusy', value: 'thinking' });
      try {
        await modelSettingsApi.select({
          source: modelSettings.overview.selection.source,
          official_model_id: officialModelId,
          thinking_level: nextThinkingLevel,
        });
        await loadModelSettings();
        void onboardingGuide.refresh();
      } catch (error) {
        toast(
          'error',
          error instanceof Error
            ? error.message
            : t('aiChat.switchThinkingFailed'),
        );
      } finally {
        dispatchModelSettings({ type: 'setToolbarBusy', value: '' });
      }
    },
    [
      loadModelSettings,
      modelSettings.overview,
      modelSettings.toolbarBusy,
      onboardingGuide,
      t,
      toast,
    ],
  );

  const openModelSettingsFromGuide = useCallback(() => {
    onboardingGuide.saveStep('model');
    router.push(`/settings/advanced?${buildGuideReturnQuery('/ai-chat')}`);
  }, [onboardingGuide, router]);

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
    dispatchPaipanSheetConfig({ type: 'close' });
  }, []);

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
  const availableOfficialModels = getAvailableOfficialModels(
    modelSettings.overview,
  );
  const selectedOfficialModel = findSelectedOfficialModel(
    modelSettings.overview,
  );
  const modelControlsDisabled =
    authLoading ||
    !chatAvailable ||
    chatMessages.sending ||
    continuationBlocked;
  const canSelectOfficialModel =
    !modelSettings.error && availableOfficialModels.length > 0;
  const canSelectThinkingLevel =
    !modelSettings.error && Boolean(modelSettings.overview?.selection);
  const aiControlTitle = modelSettings.error;
  const modelSwitchLabel = modelSettings.loading
    ? t('aiChat.toolbar.loading')
    : modelSettings.error
      ? t('aiChat.toolbar.unavailable')
      : (selectedOfficialModel?.display_name ??
        (availableOfficialModels.length > 0
          ? t('aiChat.toolbar.officialModel')
          : t('aiChat.toolbar.noOfficialModel')));
  const thinkingLevel = resolveToolbarThinkingLevel(modelSettings.overview);
  const thinkingSwitchLabel = t(`aiChat.thinkingLevels.${thinkingLevel}`);
  const paipanActionTitle = t('aiChat.toolbar.jointPaipan');
  const composer = (
    <AiChatComposer
      inputRef={chatMessages.inputRef}
      input={input}
      sending={chatMessages.sending}
      disabled={continuationBlocked}
      disabledMessage=""
      selectedSession={selectedSession}
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

  const expertCenteredComposer = (
    <div className="space-y-2.5">
      {composer}
      {onboardingGuide.shouldShowContinueEntry && (
        <OnboardingGuideEntry onOpen={onboardingGuide.openGuide} />
      )}
      {selectedSession ? (
        <ChatToolStrip
          modelLabel={modelSwitchLabel}
          modelLoading={modelSettings.loading}
          modelBusy={modelSettings.toolbarBusy === 'model'}
          modelDisabled={
            modelControlsDisabled ||
            modelSettings.loading ||
            Boolean(modelSettings.toolbarBusy) ||
            !canSelectOfficialModel
          }
          modelTitle={aiControlTitle || t('aiChat.toolbar.switchOfficialModel')}
          selectedOfficialModelId={selectedOfficialModel?.id ?? ''}
          officialModels={availableOfficialModels}
          onSelectModel={selectOfficialModel}
          thinkingLabel={thinkingSwitchLabel}
          thinkingBusy={modelSettings.toolbarBusy === 'thinking'}
          thinkingDisabled={
            modelControlsDisabled ||
            modelSettings.loading ||
            Boolean(modelSettings.toolbarBusy) ||
            !canSelectThinkingLevel
          }
          thinkingTitle={aiControlTitle || t('aiChat.toolbar.switchThinking')}
          thinkingLevel={thinkingLevel}
          onSelectThinking={selectThinkingLevel}
        />
      ) : (
        <PaipanSkillRail
          catalog={paipanCatalogState.items}
          loading={paipanCatalogState.loading}
          disabled={authLoading || chatMessages.sending}
          pastedBoardDisabled={pastedBoardDisabled}
          onSelectSkill={(skill) => openPreChatPaipan(skill)}
          onOpenSkillMarket={openSkillMarket}
          onOpenPastedBoard={handleOpenComposerPastedBoard}
        />
      )}
    </div>
  );
  // 纯专业排盘入口:进入即排盘工作台。
  const centeredContent = (
    <div className="space-y-2.5">{expertCenteredComposer}</div>
  );
  const showAnnouncementBanner = !selectedSession && !searchParams.get('sid');
  const emptyStateTitle = t('aiChat.empty.expertTitle');
  const emptyStateDescription = t('aiChat.empty.expertDescription');
  const emptyStateHint = undefined;
  const emptyStateFrameClassName = !selectedSession
    ? 'justify-start pb-8 pt-8 lg:pt-10'
    : undefined;

  return (
    <div className="flex flex-col h-[calc(100dvh-3.5rem)] lg:h-[calc(100dvh-4rem)] pt-1.5 lg:pt-0">
      <div
        ref={chatMessages.scrollRef}
        className="relative flex-1 overflow-y-auto overscroll-contain py-1.5 lg:py-3 scroll-smooth"
      >
        {showAnnouncementBanner ? <AnnouncementBanner embedded wide /> : null}
        <AiChatMessageList
          messages={displayMessages}
          loading={chatMessages.loading}
          sending={chatMessages.sending}
          progressLabel={progressLabel}
          replySlow={chatMessages.replySlow}
          onRetry={() => void chatMessages.retrySending()}
          selectedSession={selectedSession}
          switchingSession={switchingSession}
          loadingOlder={chatMessages.loadingOlder}
          showCenteredComposer={showCenteredComposer}
          latestMessageNotice={latestMessageNotice}
          composer={showCenteredComposer ? centeredContent : composer}
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

      {!showCenteredComposer && (
        <div className="shrink-0 pt-1.5 pb-1">
          <div className="max-w-2xl mx-auto px-2.5 sm:px-3">
            <div className="mb-1.5">
              <ChatToolStrip
                modelLabel={modelSwitchLabel}
                modelLoading={modelSettings.loading}
                modelBusy={modelSettings.toolbarBusy === 'model'}
                modelDisabled={
                  modelControlsDisabled ||
                  modelSettings.loading ||
                  Boolean(modelSettings.toolbarBusy) ||
                  !canSelectOfficialModel
                }
                modelTitle={
                  aiControlTitle || t('aiChat.toolbar.switchOfficialModel')
                }
                selectedOfficialModelId={selectedOfficialModel?.id ?? ''}
                officialModels={availableOfficialModels}
                onSelectModel={selectOfficialModel}
                thinkingLabel={thinkingSwitchLabel}
                thinkingBusy={modelSettings.toolbarBusy === 'thinking'}
                thinkingDisabled={
                  modelControlsDisabled ||
                  modelSettings.loading ||
                  Boolean(modelSettings.toolbarBusy) ||
                  !canSelectThinkingLevel
                }
                thinkingTitle={
                  aiControlTitle || t('aiChat.toolbar.switchThinking')
                }
                thinkingLevel={thinkingLevel}
                onSelectThinking={selectThinkingLevel}
              />
            </div>
            {composer}
            <p className="mt-1.5 flex items-center justify-center gap-1 text-center text-[10px] text-muted/50 select-none">
              <Sparkles size={10} strokeWidth={1.8} aria-hidden="true" />
              <span>{t('aiChat.composer.aiDisclaimer')}</span>
            </p>
          </div>
        </div>
      )}

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
          (paipanSheetConfig.mode !== 'current-session' || !continuationBlocked)
        }
        onClose={handleClosePaipanSheet}
        onAuthRequired={() => requestLogin(input)}
        onCommitted={handlePaipanCommitted}
      />

      <PastedBoardSheet
        open={pastedBoardSheet.sheetOpen}
        initialContent={pastedBoardSheet.draft}
        catalog={paipanCatalogState.items}
        onClose={closePastedBoardSheet}
        onSubmit={handlePastedBoardSubmit}
      />

      <OnboardingGuideDialog
        open={onboardingGuide.open}
        step={onboardingGuide.step}
        modelReady={onboardingGuide.modelReady}
        skillReady={onboardingGuide.skillReady}
        modelLoading={onboardingGuide.modelLoading}
        skillLoading={onboardingGuide.skillLoading}
        modelError={onboardingGuide.modelError}
        skillError={onboardingGuide.skillError}
        availableOfficialModelCount={
          onboardingGuide.availableOfficialModelCount
        }
        hasAnyInstalledSkill={onboardingGuide.hasAnyInstalledSkill}
        onClose={onboardingGuide.dismissGuide}
        onSaveStep={onboardingGuide.saveStep}
        onRetry={retryOnboardingGuide}
        onOpenModelSettings={openModelSettingsFromGuide}
        onOpenSkillMarket={openSkillMarketFromGuide}
        onComplete={onboardingGuide.completeGuide}
      />
    </div>
  );
}


function AiChatFloatingStatus({ status }: { status: ReplyStatus }) {
  const { t } = useI18n();
  const statusLabel =
    status === 'completed'
      ? t('aiChat.home.answerCompleted')
      : t('aiChat.home.outputStopped');
  const StatusIcon = status === 'completed' ? CheckCircle2 : CircleStop;

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

function ChatToolStrip({
  modelLabel,
  modelLoading,
  modelBusy,
  modelDisabled,
  modelTitle,
  selectedOfficialModelId,
  officialModels,
  onSelectModel,
  thinkingLabel,
  thinkingBusy,
  thinkingDisabled,
  thinkingTitle,
  thinkingLevel,
  onSelectThinking,
}: {
  modelLabel: string;
  modelLoading: boolean;
  modelBusy: boolean;
  modelDisabled?: boolean;
  modelTitle: string;
  selectedOfficialModelId: string;
  officialModels: OfficialModel[];
  onSelectModel: (modelId: string) => void;
  thinkingLabel: string;
  thinkingBusy: boolean;
  thinkingDisabled?: boolean;
  thinkingTitle: string;
  thinkingLevel: ModelThinkingLevel;
  onSelectThinking: (thinkingLevel: ModelThinkingLevel) => void;
}) {
  const { t } = useI18n();
  const [openPicker, setOpenPicker] = useState<'model' | 'thinking' | null>(
    null,
  );
  const stripRef = useRef<HTMLDivElement | null>(null);
  const chipClass =
    'group inline-flex h-8 min-w-0 max-w-full shrink items-center gap-1.5 rounded-lg border border-hairline bg-[linear-gradient(180deg,rgba(255,255,255,0.055),rgba(255,255,255,0.018))] px-2.5 text-[12px] font-medium text-ink shadow-[0_1px_0_rgba(255,255,255,0.04)_inset] transition-colors duration-150 hover:border-primary/30 hover:bg-primary/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 disabled:cursor-not-allowed disabled:bg-surface-card/40 disabled:text-muted disabled:opacity-60';

  useEffect(() => {
    if (!openPicker) return;

    const closeOnOutside = (event: PointerEvent) => {
      if (!stripRef.current?.contains(event.target as Node)) {
        setOpenPicker(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenPicker(null);
      }
    };

    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [openPicker]);

  return (
    <div
      ref={stripRef}
      className="flex min-h-8 min-w-0 flex-wrap items-center gap-1.5"
    >
      <div className="relative min-w-0 shrink">
        <button
          type="button"
          title={modelTitle}
          disabled={modelDisabled}
          onClick={() =>
            setOpenPicker((current) => (current === 'model' ? null : 'model'))
          }
          className={chipClass}
          aria-haspopup="menu"
          aria-expanded={openPicker === 'model'}
          aria-label={t('aiChat.toolbar.selectOfficialModel', {
            model: modelLabel,
          })}
        >
          {modelLoading || modelBusy ? (
            <Loader2 size={13} className="shrink-0 animate-spin text-primary" />
          ) : (
            <Bot size={13} className="shrink-0 text-primary" />
          )}
          <span className="whitespace-nowrap">{t('aiChat.toolbar.model')}</span>
          <span className="min-w-0 max-w-[min(24vw,96px)] truncate text-muted group-hover:text-primary">
            {modelLabel}
          </span>
          <ChevronDown
            size={12}
            className={`shrink-0 text-muted transition-transform duration-150 ${
              openPicker === 'model' ? 'rotate-180 text-primary' : ''
            }`}
          />
        </button>
        {openPicker === 'model' && (
          <div
            className="absolute bottom-full left-0 z-40 mb-2 w-64 overflow-hidden rounded-xl border border-hairline bg-surface-card shadow-[0_14px_36px_rgba(0,0,0,0.14)]"
            role="menu"
          >
            <div className="border-b border-hairline/70 px-3 py-2 text-[10px] font-medium text-muted">
              {t('aiChat.toolbar.officialModels')}
            </div>
            <div className="max-h-64 overflow-y-auto p-1.5">
              {officialModels.map((model) => {
                const selected = model.id === selectedOfficialModelId;
                return (
                  <button
                    key={model.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    onClick={() => {
                      setOpenPicker(null);
                      if (!selected) onSelectModel(model.id);
                    }}
                    className={`flex min-h-9 w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] transition-colors ${
                      selected
                        ? 'bg-primary/12 text-primary'
                        : 'text-ink hover:bg-surface-cream-strong'
                    }`}
                  >
                    <span className="min-w-0 truncate">
                      {model.display_name}
                    </span>
                    {selected && (
                      <CheckCircle2 size={13} className="shrink-0" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div className="relative min-w-0 shrink">
        <button
          type="button"
          title={thinkingTitle}
          disabled={thinkingDisabled}
          onClick={() =>
            setOpenPicker((current) =>
              current === 'thinking' ? null : 'thinking',
            )
          }
          className={chipClass}
          aria-haspopup="menu"
          aria-expanded={openPicker === 'thinking'}
          aria-label={t('aiChat.toolbar.selectThinking', {
            level: thinkingLabel,
          })}
        >
          {thinkingBusy ? (
            <Loader2 size={13} className="shrink-0 animate-spin text-primary" />
          ) : (
            <Brain size={13} className="shrink-0 text-primary" />
          )}
          <span className="whitespace-nowrap">
            {t('aiChat.toolbar.thinking')}
          </span>
          <span className="text-muted group-hover:text-primary">
            {thinkingLabel}
          </span>
          <ChevronDown
            size={12}
            className={`shrink-0 text-muted transition-transform duration-150 ${
              openPicker === 'thinking' ? 'rotate-180 text-primary' : ''
            }`}
          />
        </button>
        {openPicker === 'thinking' && (
          <div
            className="absolute bottom-full right-0 z-40 mb-2 w-36 overflow-hidden rounded-xl border border-hairline bg-surface-card p-1.5 shadow-[0_14px_36px_rgba(0,0,0,0.14)]"
            role="menu"
          >
            {THINKING_LEVEL_OPTIONS.map((option) => {
              const selected = option.value === thinkingLevel;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  onClick={() => {
                    setOpenPicker(null);
                    if (!selected) onSelectThinking(option.value);
                  }}
                  className={`flex h-8 w-full items-center justify-between rounded-lg px-2.5 text-[12px] transition-colors ${
                    selected
                      ? 'bg-primary/12 text-primary'
                      : 'text-ink hover:bg-surface-cream-strong'
                  }`}
                >
                  <span>{t(option.labelKey)}</span>
                  {selected && <CheckCircle2 size={13} className="shrink-0" />}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
