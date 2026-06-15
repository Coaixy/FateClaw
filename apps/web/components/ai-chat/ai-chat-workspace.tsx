'use client';

import {
  Suspense,
  type ClipboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import {
  ArrowLeft,
  Bot,
  Brain,
  CalendarCheck,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Compass,
  Loader2,
  LogIn,
  Sparkles,
  Workflow,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { AnnouncementBanner } from '@/components/announcements/announcement-banner';
import { AiChatComposer } from '@/components/ai-chat/ai-chat-composer';
import { AiChatMessageList } from '@/components/ai-chat/ai-chat-message-list';
import { OnboardingGuideDialog } from '@/components/ai-chat/onboarding-guide-dialog';
import { PaipanSkillRail } from '@/components/ai-chat/paipan-skill-rail';
import { SimpleModeWorkspace } from '@/components/ai-chat/simple-mode-workspace';
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
import { useChatMessages } from '@/features/chat/hooks/use-chat-messages';
import { useChatSessions } from '@/features/chat/hooks/use-chat-sessions';
import { useAuth } from '@/features/auth/hooks/use-auth';
import { billingApi, type DailySignInStatus } from '@/features/billing/api';
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
import { formatCoins } from '@/lib/soft-currency';
import { useToast } from '@/lib/use-toast';

type PaipanSheetMode = 'pre-chat' | 'current-session';
type PasteChoiceSelection = {
  readonly start: number;
  readonly end: number;
};
type HomeMode = 'select' | 'simple' | 'expert';
type PastedBoardDraftSource = 'composer' | 'paste' | 'manual';
type ReplyStatus = 'completed' | 'interrupted';
type ModelToolbarBusy = '' | 'model' | 'thinking';
const PENDING_CHAT_INPUT_KEY = 'fateclaw:ai-chat:pending-input';
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
const PaipanSkillPickerSheet = dynamic(
  () =>
    import('@/components/ai-chat/paipan-skill-picker-sheet').then(
      (module) => module.PaipanSkillPickerSheet,
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
  const {
    status: billingStatus,
    loading: billingLoading,
  } = useBillingSnapshot();
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
  const [paipanSheetMode, setPaipanSheetMode] =
    useState<PaipanSheetMode | null>(null);
  const [paipanSkillPickerOpen, setPaipanSkillPickerOpen] = useState(false);
  const [paipanCatalog, setPaipanCatalog] = useState<PaipanCatalogItem[]>([]);
  const [paipanCatalogLoading, setPaipanCatalogLoading] = useState(false);
  const [preselectedPaipanSkill, setPreselectedPaipanSkill] = useState<
    string | null
  >(null);
  const [lockPaipanSkill, setLockPaipanSkill] = useState(false);
  const [pastedBoardDraft, setPastedBoardDraft] = useState('');
  const [pastedBoardSheetOpen, setPastedBoardSheetOpen] = useState(false);
  const [pastedBoardDraftSource, setPastedBoardDraftSource] =
    useState<PastedBoardDraftSource>('manual');
  const [pasteChoiceText, setPasteChoiceText] = useState('');
  const [pasteChoiceSelection, setPasteChoiceSelection] =
    useState<PasteChoiceSelection | null>(null);
  const [homeMode, setHomeMode] = useState<HomeMode>('select');
  const [replyStatus, setReplyStatus] = useState<ReplyStatus | null>(null);
  const [modelOverview, setModelOverview] =
    useState<ModelSettingsOverview | null>(null);
  const [modelSettingsLoading, setModelSettingsLoading] = useState(false);
  const [modelSettingsError, setModelSettingsError] = useState('');
  const [modelToolbarBusy, setModelToolbarBusy] =
    useState<ModelToolbarBusy>('');
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
  const continuationBlockedMessage =
    continuationBlocked && selectedSession
      ? chatMessages.continuationBlockMessage ||
        t('aiChat.continuationBlockedFallback')
      : '';
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

  useEffect(() => {
    setPaipanSkillPickerOpen(false);
  }, [chatAvailable]);

  const loadModelSettings = useCallback(async () => {
    if (!chatAvailable || authLoading) {
      return;
    }

    const requestId = modelSettingsRequestIdRef.current + 1;
    modelSettingsRequestIdRef.current = requestId;
    setModelSettingsLoading(true);
    setModelSettingsError('');

    try {
      const data = await modelSettingsApi.overview();
      if (modelSettingsRequestIdRef.current !== requestId) return;
      setModelOverview(data);
    } catch (error) {
      if (modelSettingsRequestIdRef.current !== requestId) return;
      setModelOverview(null);
      setModelSettingsError(
        error instanceof Error ? error.message : t('aiChat.loadModelSettingsFailed'),
      );
    } finally {
      if (modelSettingsRequestIdRef.current === requestId) {
        setModelSettingsLoading(false);
      }
    }
  }, [authLoading, chatAvailable, t]);

  useEffect(() => {
    if (!chatAvailable || authLoading) {
      modelSettingsRequestIdRef.current += 1;
      setModelOverview(null);
      setModelSettingsLoading(false);
      setModelSettingsError('');
      setModelToolbarBusy('');
      return;
    }

    void loadModelSettings();
  }, [authLoading, chatAvailable, loadModelSettings]);

  useEffect(() => {
    let cancelled = false;
    setPaipanCatalog([]);
    setPaipanCatalogLoading(true);

    const cancelIdleTask = scheduleIdleTask(() => {
      if (cancelled) return;

      // 术数目录由工作台统一加载，避免空态入口和排盘弹层各自重复请求。
      void paipanApi
        .catalog()
        .then((items) => {
          if (cancelled) return;
          setPaipanCatalog(items);
        })
        .catch((error) => {
          if (cancelled) return;
          setPaipanCatalog([]);
          toast(
            'error',
            error instanceof Error ? error.message : t('aiChat.loadPaipanFailed'),
          );
        })
        .finally(() => {
          if (!cancelled) {
            setPaipanCatalogLoading(false);
          }
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
      setPastedBoardDraft(content);
      setPastedBoardDraftSource(source);
      setPastedBoardSheetOpen(true);
      setPasteChoiceText('');
      setPasteChoiceSelection(null);
    },
    [],
  );

  const closePastedBoardSheet = useCallback(() => {
    setPastedBoardSheetOpen(false);
  }, []);

  const handleComposerPaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      if (chatMessages.sending || continuationBlocked || !chatAvailable) {
        return;
      }

      const text = event.clipboardData.getData('text');
      if (!shouldPromptForPastedBoard(text)) return;

      event.preventDefault();
      setPasteChoiceSelection({
        start: event.currentTarget.selectionStart,
        end: event.currentTarget.selectionEnd,
      });
      setPasteChoiceText(text);
    },
    [chatAvailable, continuationBlocked, chatMessages.sending],
  );

  const handleUsePasteAsBoard = useCallback(() => {
    openPastedBoardSheet(pasteChoiceText, 'paste');
    setPasteChoiceText('');
    setPasteChoiceSelection(null);
  }, [openPastedBoardSheet, pasteChoiceText]);

  const handleKeepPasteAsMessage = useCallback(() => {
    if (!pasteChoiceText) return;
    setInput((previous) => {
      if (
        pasteChoiceSelection &&
        pasteChoiceSelection.start >= 0 &&
        pasteChoiceSelection.end >= pasteChoiceSelection.start &&
        pasteChoiceSelection.end <= previous.length
      ) {
        const beforeSelection = previous.slice(0, pasteChoiceSelection.start);
        const afterSelection = previous.slice(pasteChoiceSelection.end);
        return `${beforeSelection}${pasteChoiceText}${afterSelection}`;
      }

      const separator = previous && !previous.endsWith('\n') ? '\n' : '';
      return `${previous}${separator}${pasteChoiceText}`;
    });
    setPasteChoiceText('');
    setPasteChoiceSelection(null);
  }, [pasteChoiceSelection, pasteChoiceText]);

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
        toast('error', continuationBlockedMessage);
        return;
      }

      if (chatMessages.sending) {
        toast('error', t('aiChat.previousMessageProcessing'));
        return;
      }
      startUserPastedBoardSubmission({
        pastedBoard,
        sendMessage: chatMessages.sendMessageWithOptions,
        closeSheet: () => setPastedBoardSheetOpen(false),
        clearComposerInput:
          pastedBoardDraftSource === 'composer'
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
      continuationBlockedMessage,
      pastedBoardDraftSource,
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

  const handleSimpleWorkflowStarted = useCallback(
    async (result: { session: PaipanCommitResponse['session'] }) => {
      touchSession(result.session.id, result.session);
      setSelectedSession(result.session.id);
    },
    [setSelectedSession, touchSession],
  );

  const openPreChatPaipan = useCallback(
    (skill?: string) => {
      if (authLoading) {
        return;
      }

      setPaipanSkillPickerOpen(false);
      setPreselectedPaipanSkill(skill ?? null);
      setLockPaipanSkill(Boolean(skill));
      setPaipanSheetMode('pre-chat');
    },
    [authLoading],
  );

  const openPaipanSkillPicker = useCallback(() => {
    if (authLoading) {
      return;
    }

    setPaipanSkillPickerOpen(true);
  }, [authLoading]);

  const openSkillMarket = useCallback(() => {
    router.push('/discover');
  }, [router]);

  const selectOfficialModel = useCallback(
    async (officialModelId: string) => {
      if (!modelOverview || modelToolbarBusy || !officialModelId) {
        return;
      }

      const officialModels = getAvailableOfficialModels(modelOverview);
      const nextModel = officialModels.find(
        (model) => model.id === officialModelId,
      );
      if (!nextModel) {
        toast('error', t('aiChat.onlyAvailableOfficialModel'));
        return;
      }

      if (
        modelOverview.selection?.source === 'official' &&
        modelOverview.selection.official_model_id === nextModel.id
      ) {
        return;
      }

      const thinkingLevel = resolveToolbarThinkingLevel(modelOverview);

      setModelToolbarBusy('model');
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
          error instanceof Error ? error.message : t('aiChat.switchModelFailed'),
        );
      } finally {
        setModelToolbarBusy('');
      }
    },
    [
      loadModelSettings,
      modelOverview,
      modelToolbarBusy,
      onboardingGuide,
      t,
      toast,
    ],
  );

  const selectThinkingLevel = useCallback(
    async (nextThinkingLevel: ModelThinkingLevel) => {
      if (!modelOverview || modelToolbarBusy || !modelOverview.selection) {
        return;
      }

      if (nextThinkingLevel === resolveToolbarThinkingLevel(modelOverview)) {
        return;
      }

      const selectedOfficial = findSelectedOfficialModel(modelOverview);
      const fallbackOfficial = getAvailableOfficialModels(modelOverview)[0];
      const officialModelId =
        modelOverview.selection.source === 'official'
          ? (selectedOfficial?.id ?? fallbackOfficial?.id ?? null)
          : null;

      if (modelOverview.selection.source === 'official' && !officialModelId) {
        toast('error', t('aiChat.noAvailableOfficialModel'));
        return;
      }

      setModelToolbarBusy('thinking');
      try {
        await modelSettingsApi.select({
          source: modelOverview.selection.source,
          official_model_id: officialModelId,
          thinking_level: nextThinkingLevel,
        });
        await loadModelSettings();
        void onboardingGuide.refresh();
      } catch (error) {
        toast(
          'error',
          error instanceof Error ? error.message : t('aiChat.switchThinkingFailed'),
        );
      } finally {
        setModelToolbarBusy('');
      }
    },
    [
      loadModelSettings,
      modelOverview,
      modelToolbarBusy,
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
        toast('error', continuationBlockedMessage);
        return;
      }

      setPaipanSkillPickerOpen(false);
      setPreselectedPaipanSkill(skill ?? null);
      setLockPaipanSkill(Boolean(skill));
      setPaipanSheetMode('current-session');
    },
    [authLoading, continuationBlocked, continuationBlockedMessage, toast],
  );

  const handleClosePaipanSheet = useCallback(() => {
    setPaipanSheetMode(null);
    setPreselectedPaipanSkill(null);
    setLockPaipanSkill(false);
  }, []);

  const handleClosePaipanSkillPicker = useCallback(() => {
    setPaipanSkillPickerOpen(false);
  }, []);

  const handleSelectSkillFromPicker = useCallback(
    (skill: string) => {
      setPaipanSkillPickerOpen(false);
      openPreChatPaipan(skill);
    },
    [openPreChatPaipan],
  );

  const handleOpenComposerPastedBoard = useCallback(() => {
    if (authLoading) {
      return;
    }

    if (!chatAvailable) {
      requestLogin(input);
      return;
    }
    if (continuationBlocked) {
      toast('error', continuationBlockedMessage);
      return;
    }

    openPastedBoardSheet(input, 'composer');
  }, [
    authLoading,
    chatAvailable,
    continuationBlocked,
    continuationBlockedMessage,
    input,
    openPastedBoardSheet,
    requestLogin,
    toast,
  ]);
  const pastedBoardDisabled =
    authLoading || chatMessages.sending || continuationBlocked;
  const availableOfficialModels = getAvailableOfficialModels(modelOverview);
  const selectedOfficialModel = findSelectedOfficialModel(modelOverview);
  const modelControlsDisabled =
    authLoading ||
    !chatAvailable ||
    chatMessages.sending ||
    continuationBlocked;
  const canSelectOfficialModel =
    !modelSettingsError && availableOfficialModels.length > 0;
  const canSelectThinkingLevel =
    !modelSettingsError && Boolean(modelOverview?.selection);
  const aiControlTitle = modelSettingsError;
  const modelSwitchLabel = modelSettingsLoading
    ? t('aiChat.toolbar.loading')
    : modelSettingsError
      ? t('aiChat.toolbar.unavailable')
      : (selectedOfficialModel?.display_name ??
        (availableOfficialModels.length > 0
          ? t('aiChat.toolbar.officialModel')
          : t('aiChat.toolbar.noOfficialModel')));
  const thinkingLevel = resolveToolbarThinkingLevel(modelOverview);
  const thinkingSwitchLabel = t(`aiChat.thinkingLevels.${thinkingLevel}`);
  const paipanActionTitle = t('aiChat.toolbar.jointPaipan');
  const composer = (
    <AiChatComposer
      inputRef={chatMessages.inputRef}
      input={input}
      sending={chatMessages.sending}
      disabled={continuationBlocked}
      disabledMessage={continuationBlockedMessage}
      selectedSession={selectedSession}
      paipanAction={
        selectedSession
          ? {
              loading: paipanCatalogLoading,
              disabled:
                authLoading ||
                chatMessages.sending ||
                continuationBlocked ||
                paipanCatalogLoading ||
                paipanCatalog.length === 0,
              title: paipanActionTitle,
              onOpen: () => openCurrentSessionPaipan(),
            }
          : undefined
      }
      pasteChoiceOpen={Boolean(pasteChoiceText)}
      pasteChoicePreview={pasteChoiceText}
      onInputChange={handleInputChange}
      onPaste={handleComposerPaste}
      onKeyDown={handleKeyDown}
      onUsePasteAsBoard={handleUsePasteAsBoard}
      onKeepPasteAsMessage={handleKeepPasteAsMessage}
      onDismissPasteChoice={() => {
        setPasteChoiceText('');
        setPasteChoiceSelection(null);
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
          modelLoading={modelSettingsLoading}
          modelBusy={modelToolbarBusy === 'model'}
          modelDisabled={
            modelControlsDisabled ||
            modelSettingsLoading ||
            Boolean(modelToolbarBusy) ||
            !canSelectOfficialModel
          }
          modelTitle={aiControlTitle || t('aiChat.toolbar.switchOfficialModel')}
          selectedOfficialModelId={selectedOfficialModel?.id ?? ''}
          officialModels={availableOfficialModels}
          onSelectModel={selectOfficialModel}
          thinkingLabel={thinkingSwitchLabel}
          thinkingBusy={modelToolbarBusy === 'thinking'}
          thinkingDisabled={
            modelControlsDisabled ||
            modelSettingsLoading ||
            Boolean(modelToolbarBusy) ||
            !canSelectThinkingLevel
          }
          thinkingTitle={aiControlTitle || t('aiChat.toolbar.switchThinking')}
          thinkingLevel={thinkingLevel}
          onSelectThinking={selectThinkingLevel}
        />
      ) : (
        <PaipanSkillRail
          catalog={paipanCatalog}
          loading={paipanCatalogLoading}
          enabledSkills={onboardingGuide.enabledSkills}
          enabledSkillsLoading={onboardingGuide.enabledSkillsLoading}
          showEnabledSkillsEmptyState={chatAvailable}
          disabled={authLoading || chatMessages.sending}
          pastedBoardDisabled={pastedBoardDisabled}
          onSelectSkill={(skill) => openPreChatPaipan(skill)}
          onOpenAll={openPaipanSkillPicker}
          onOpenSkillMarket={openSkillMarket}
          onOpenPastedBoard={handleOpenComposerPastedBoard}
        />
      )}
    </div>
  );
  const showHomeModeSelector = !selectedSession && homeMode === 'select';
  const centeredContent = showHomeModeSelector ? (
    <HomeModeSelector
      loginRequired={!authLoading && !user}
      dailySignInEntry={
        !authLoading && user ? <DailySignInHomeEntry /> : null
      }
      onLogin={() => requestLogin()}
      onOpenSimple={() => setHomeMode('simple')}
      onOpenExpert={() => setHomeMode('expert')}
    />
  ) : !selectedSession && homeMode === 'simple' ? (
    <SimpleModeWorkspace
      disabled={authLoading || chatMessages.sending}
      chatAvailable={chatAvailable}
      onBack={() => setHomeMode('select')}
      onAuthRequired={(draft) => requestLogin(draft)}
      onStarted={(result) => void handleSimpleWorkflowStarted(result)}
    />
  ) : !selectedSession ? (
    <ExpertModeFrame onBack={() => setHomeMode('select')}>
      {expertCenteredComposer}
    </ExpertModeFrame>
  ) : (
    expertCenteredComposer
  );
  const showSimpleModeWorkspace = !selectedSession && homeMode === 'simple';
  const showAnnouncementBanner = !selectedSession && !searchParams.get('sid');
  const emptyStateTitle =
    !selectedSession && homeMode !== 'expert' ? '' : t('aiChat.empty.expertTitle');
  const emptyStateDescription =
    !selectedSession && homeMode !== 'expert'
      ? ''
      : t('aiChat.empty.expertDescription');
  const emptyStateHint =
    !selectedSession && homeMode !== 'expert' ? '' : undefined;
  const emptyStateFrameClassName =
    !selectedSession && homeMode === 'expert'
      ? 'justify-start pb-8 pt-8 lg:pt-10'
      : undefined;

  return (
    <div className="flex flex-col h-[calc(100dvh-3.5rem)] lg:h-[calc(100dvh-4rem)] pt-1.5 lg:pt-0">
      <div
        ref={chatMessages.scrollRef}
        className="relative flex-1 overflow-y-auto overscroll-contain py-1.5 lg:py-3 scroll-smooth"
      >
        {showAnnouncementBanner ? (
          <AnnouncementBanner embedded wide />
        ) : null}
        <AiChatMessageList
          messages={displayMessages}
          loading={chatMessages.loading}
          sending={chatMessages.sending}
          progressLabel={progressLabel}
          selectedSession={selectedSession}
          switchingSession={switchingSession}
          showCenteredComposer={showCenteredComposer}
          latestMessageNotice={latestMessageNotice}
          composer={showCenteredComposer ? centeredContent : composer}
          emptyStateTitle={emptyStateTitle}
          emptyStateDescription={emptyStateDescription}
          emptyStateHint={emptyStateHint}
          emptyStateFrameClassName={emptyStateFrameClassName}
          emptyStateMaxWidthClassName={
            showHomeModeSelector || showSimpleModeWorkspace
              ? 'max-w-3xl'
              : 'max-w-xl'
          }
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
                modelLoading={modelSettingsLoading}
                modelBusy={modelToolbarBusy === 'model'}
                modelDisabled={
                  modelControlsDisabled ||
                  modelSettingsLoading ||
                  Boolean(modelToolbarBusy) ||
                  !canSelectOfficialModel
                }
                modelTitle={
                  aiControlTitle || t('aiChat.toolbar.switchOfficialModel')
                }
                selectedOfficialModelId={selectedOfficialModel?.id ?? ''}
                officialModels={availableOfficialModels}
                onSelectModel={selectOfficialModel}
                thinkingLabel={thinkingSwitchLabel}
                thinkingBusy={modelToolbarBusy === 'thinking'}
                thinkingDisabled={
                  modelControlsDisabled ||
                  modelSettingsLoading ||
                  Boolean(modelToolbarBusy) ||
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

      <PaipanSkillPickerSheet
        open={paipanSkillPickerOpen}
        catalog={paipanCatalog}
        loading={paipanCatalogLoading}
        onClose={handleClosePaipanSkillPicker}
        onSelectSkill={handleSelectSkillFromPicker}
      />

      <PaipanSheet
        open={paipanSheetMode !== null}
        mode={paipanSheetMode ?? 'pre-chat'}
        catalog={paipanCatalog}
        catalogLoading={paipanCatalogLoading}
        sessionId={selectedSession || undefined}
        initialSkill={preselectedPaipanSkill}
        lockSkill={lockPaipanSkill}
        canCommit={
          chatAvailable &&
          (paipanSheetMode !== 'current-session' || !continuationBlocked)
        }
        onClose={handleClosePaipanSheet}
        onAuthRequired={() => requestLogin(input)}
        onCommitted={handlePaipanCommitted}
      />

      <PastedBoardSheet
        open={pastedBoardSheetOpen}
        initialContent={pastedBoardDraft}
        catalog={paipanCatalog}
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

function HomeModeSelector({
  loginRequired,
  dailySignInEntry,
  onLogin,
  onOpenSimple,
  onOpenExpert,
}: {
  loginRequired: boolean;
  dailySignInEntry: ReactNode;
  onLogin: () => void;
  onOpenSimple: () => void;
  onOpenExpert: () => void;
}) {
  const { t } = useI18n();

  return (
    <div className="space-y-2.5">
      <div className="text-center">
        <h1 className="font-display text-[28px] font-semibold tracking-tight text-ink sm:text-[34px]">
          {t('common.productTitle')}
        </h1>
        <p className="mt-1 text-[12px] text-muted">
          {t('aiChat.home.subtitle')}
        </p>
      </div>

      {loginRequired && (
        <div className="rounded-2xl border border-primary/30 bg-[linear-gradient(180deg,rgba(204,120,92,0.14),rgba(204,120,92,0.055))] px-4 py-4 text-left shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span className="flex min-w-0 items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary text-on-primary shadow-sm">
                <LogIn size={17} />
              </span>
              <span className="min-w-0">
                <span className="block text-[16px] font-semibold tracking-tight text-ink">
                  {t('aiChat.home.loginTitle')}
                </span>
                <span className="mt-1 block text-[12px] leading-5 text-muted">
                  {t('aiChat.home.loginDescription')}
                </span>
              </span>
            </span>
            <button
              type="button"
              onClick={onLogin}
              className="inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-xl bg-primary px-4 text-[13px] font-semibold text-on-primary shadow-sm transition-colors hover:bg-primary-active focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35"
            >
              <LogIn size={14} />
              {t('aiChat.home.loginNow')}
            </button>
          </div>
        </div>
      )}

      {dailySignInEntry}

      <div className="grid gap-2.5 sm:grid-cols-2">
        <button
          type="button"
          onClick={onOpenSimple}
          className="group flex min-h-[172px] flex-col justify-between rounded-2xl border border-primary/35 bg-[linear-gradient(135deg,rgba(204,120,92,0.18),rgba(232,165,90,0.12)_48%,rgba(255,255,255,0.22))] p-4 text-left shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/55 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 active:scale-[0.99]"
        >
          <span className="flex items-start justify-between gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-on-primary shadow-sm">
              <Workflow size={18} />
            </span>
            <span className="inline-flex items-center gap-1 rounded-full border border-primary bg-primary px-2 py-1 text-[10px] font-semibold text-on-primary shadow-sm">
              <Sparkles size={11} strokeWidth={2} />
              {t('aiChat.home.recommended')}
            </span>
          </span>

          <span className="mt-5 block space-y-1">
            <span className="block text-[18px] font-semibold text-ink">
              {t('aiChat.home.quickMode')}
            </span>
            <span className="block text-[12px] leading-5 text-body">
              {t('aiChat.home.quickDescription')}
            </span>
          </span>

          <span className="mt-4 inline-flex w-fit items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-[12px] font-semibold text-on-primary shadow-sm transition-colors duration-200 group-hover:bg-primary-active">
            {t('aiChat.home.quickAction')}
            <ChevronRight
              size={13}
              className="transition-transform duration-200 group-hover:translate-x-0.5"
            />
          </span>
        </button>

        <button
          type="button"
          onClick={onOpenExpert}
          className="group flex min-h-[172px] flex-col justify-between rounded-2xl border border-primary/20 bg-[linear-gradient(180deg,rgba(204,120,92,0.08),rgba(255,255,255,0.04))] p-4 text-left shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:bg-primary/10 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 active:scale-[0.99]"
        >
          <span className="flex items-start justify-between gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/14 text-primary">
              <Compass size={18} />
            </span>
            <span className="inline-flex items-center gap-1 rounded-full border border-primary/25 bg-surface-card/70 px-2 py-1 text-[10px] font-medium text-primary">
              <CheckCircle2 size={11} strokeWidth={2} />
              {t('aiChat.home.expertBadge')}
            </span>
          </span>

          <span className="mt-5 block space-y-1">
            <span className="block text-[17px] font-semibold text-ink">
              {t('aiChat.home.expertMode')}
            </span>
            <span className="block text-[12px] leading-5 text-muted">
              {t('aiChat.home.expertDescription')}
            </span>
          </span>

          <span className="mt-4 inline-flex items-center gap-1.5 text-[12px] font-medium text-primary">
            {t('aiChat.home.expertAction')}
            <ChevronRight
              size={13}
              className="transition-transform duration-200 group-hover:translate-x-0.5"
            />
          </span>
        </button>
      </div>
    </div>
  );
}

function DailySignInHomeEntry() {
  const { locale, t } = useI18n();
  const { toast } = useToast();
  const [status, setStatus] = useState<DailySignInStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await billingApi.dailySignInStatus());
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const enabled = Boolean(status?.enabled);
  const signedIn = Boolean(status?.signed_in_today);
  const rewardCoins = status?.reward_coins ?? 0;
  const canClaim = enabled && !signedIn && rewardCoins > 0;

  const claim = async () => {
    if (!canClaim || busy) return;

    setBusy(true);
    try {
      const result = await billingApi.claimDailySignIn();
      setStatus(result);
      toast(
        'success',
        t('pages.dailySignIn.claimed', {
          coins: formatCoins(result.received_coins, locale),
        }),
      );
    } catch (err) {
      toast(
        'error',
        err instanceof Error ? err.message : t('pages.dailySignIn.claimFailed'),
      );
      await loadStatus();
    } finally {
      setBusy(false);
    }
  };

  if (loading || !canClaim) {
    return null;
  }

  return (
    <button
      type="button"
      onClick={() => void claim()}
      disabled={busy}
      className="group flex w-full items-center justify-between gap-3 rounded-2xl border border-primary/25 bg-primary/8 px-4 py-3 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/45 hover:bg-primary/12 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 active:translate-y-0 disabled:cursor-wait disabled:opacity-70"
    >
      <span className="flex min-w-0 items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/14 text-primary">
          {busy ? (
            <Loader2 size={17} className="animate-spin" />
          ) : (
            <CalendarCheck size={17} />
          )}
        </span>
        <span className="min-w-0">
          <span className="block text-[13px] font-semibold text-ink">
            {t('pages.dailySignIn.title')}
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-muted">
            {t('pages.dailySignIn.claimable', {
              coins: formatCoins(rewardCoins, locale),
            })}
          </span>
        </span>
      </span>
      <span className="inline-flex h-8 shrink-0 items-center justify-center rounded-full bg-primary px-3 text-[12px] font-semibold text-on-primary transition-colors group-hover:bg-primary-active">
        {t('pages.dailySignIn.signButton')}
      </span>
    </button>
  );
}

function ExpertModeFrame({
  children,
  onBack,
}: {
  children: ReactNode;
  onBack: () => void;
}) {
  const { t } = useI18n();

  return (
    <div className="space-y-2.5">
      <div className="flex justify-start">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-hairline bg-surface-card/60 px-3 text-[12px] font-medium text-muted transition-colors hover:border-primary/30 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35"
        >
          <ArrowLeft size={13} />
          {t('aiChat.home.backToMode')}
        </button>
      </div>
      {children}
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
    <div ref={stripRef} className="flex min-h-8 min-w-0 flex-wrap items-center gap-1.5">
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
          <span className="whitespace-nowrap">
            {t('aiChat.toolbar.model')}
          </span>
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
