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
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import {
  ArrowLeft,
  Bot,
  Brain,
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
import { buildGuideReturnQuery } from '@/lib/return-to';
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
  label: string;
}> = [
  { value: 'off', label: '关闭' },
  { value: 'minimal', label: '极简' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '极高' },
];
const THINKING_LEVEL_LABELS: Record<ModelThinkingLevel, string> = {
  off: '关闭',
  minimal: '极简',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
};
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
  return overview?.selection?.thinking_level ?? DEFAULT_THINKING_LEVEL;
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
  const { toast } = useToast();
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const {
    chatAvailable,
    sessions,
    selectedSession,
    selectedSessionRevision,
    setSelectedSession,
    createSession,
    touchSession,
    loading: sessionsLoading,
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
        '此对话长期未活跃，历史上下文已归档，不支持继续追问。请新建对话。'
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
        error instanceof Error ? error.message : '加载模型设置失败',
      );
    } finally {
      if (modelSettingsRequestIdRef.current === requestId) {
        setModelSettingsLoading(false);
      }
    }
  }, [authLoading, chatAvailable]);

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
            error instanceof Error ? error.message : '加载排盘术数失败',
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
  }, [toast]);

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
          error instanceof Error ? error.message : '发送失败，请稍后重试',
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
        toast('error', '上一条消息仍在处理中，请稍后再试');
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
          toast('error', '盘面发送失败，请稍后重试');
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
      toast,
    ],
  );

  const displayMessages = filterProgressMessages(chatMessages.messages);
  const progressLabel = chatMessages.sending
    ? getLatestProgressLabel(chatMessages.messages)
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
        toast('error', '只能选择可用官方模型');
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
        toast('error', error instanceof Error ? error.message : '切换模型失败');
      } finally {
        setModelToolbarBusy('');
      }
    },
    [
      loadModelSettings,
      modelOverview,
      modelToolbarBusy,
      onboardingGuide,
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
        toast('error', '当前没有可用官方模型');
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
          error instanceof Error ? error.message : '切换思考等级失败',
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
  const modelSwitchLabel = modelSettingsLoading
    ? '加载中'
    : modelSettingsError
      ? '不可用'
      : (selectedOfficialModel?.display_name ??
        (availableOfficialModels.length > 0 ? '官方模型' : '无官方'));
  const thinkingLevel = resolveToolbarThinkingLevel(modelOverview);
  const thinkingSwitchLabel = THINKING_LEVEL_LABELS[thinkingLevel];
  const composer = (
    <AiChatComposer
      inputRef={chatMessages.inputRef}
      input={input}
      sending={chatMessages.sending}
      disabled={continuationBlocked}
      disabledMessage={continuationBlockedMessage}
      selectedSession={selectedSession}
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
          catalog={paipanCatalog}
          loading={paipanCatalogLoading}
          disabled={authLoading || chatMessages.sending || continuationBlocked}
          onOpenAll={() => openCurrentSessionPaipan()}
          modelLabel={modelSwitchLabel}
          modelLoading={modelSettingsLoading}
          modelBusy={modelToolbarBusy === 'model'}
          modelDisabled={
            modelControlsDisabled ||
            modelSettingsLoading ||
            Boolean(modelToolbarBusy) ||
            !canSelectOfficialModel
          }
          modelTitle={modelSettingsError || '切换官方模型'}
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
          thinkingTitle={modelSettingsError || '切换思考等级'}
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
  const emptyStateTitle =
    !selectedSession && homeMode !== 'expert' ? '' : '专家模式';
  const emptyStateDescription =
    !selectedSession && homeMode !== 'expert'
      ? ''
      : '直接输入问题，或使用手动排盘、自贴盘面和 Skill';
  const emptyStateHint =
    !selectedSession && homeMode !== 'expert' ? '' : undefined;

  return (
    <div className="flex flex-col h-[calc(100dvh-3.5rem)] lg:h-[calc(100dvh-4rem)] pt-1.5 lg:pt-0">
      <div
        ref={chatMessages.scrollRef}
        className="relative flex-1 overflow-y-auto overscroll-contain py-1.5 lg:py-3 scroll-smooth"
      >
        <AiChatMessageList
          messages={displayMessages}
          loading={chatMessages.loading}
          sending={chatMessages.sending}
          progressLabel={progressLabel}
          selectedSession={selectedSession}
          switchingSession={switchingSession}
          showCenteredComposer={showCenteredComposer}
          composer={showCenteredComposer ? centeredContent : composer}
          emptyStateTitle={emptyStateTitle}
          emptyStateDescription={emptyStateDescription}
          emptyStateHint={emptyStateHint}
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
                catalog={paipanCatalog}
                loading={paipanCatalogLoading}
                disabled={
                  authLoading ||
                  chatMessages.sending ||
                  continuationBlocked ||
                  !selectedSession
                }
                onOpenAll={() => openCurrentSessionPaipan()}
                modelLabel={modelSwitchLabel}
                modelLoading={modelSettingsLoading}
                modelBusy={modelToolbarBusy === 'model'}
                modelDisabled={
                  modelControlsDisabled ||
                  modelSettingsLoading ||
                  Boolean(modelToolbarBusy) ||
                  !canSelectOfficialModel
                }
                modelTitle={modelSettingsError || '切换官方模型'}
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
                thinkingTitle={modelSettingsError || '切换思考等级'}
                thinkingLevel={thinkingLevel}
                onSelectThinking={selectThinkingLevel}
              />
            </div>
            {composer}
            <p className="block text-[10px] text-muted/50 text-center mt-1.5 select-none">
              Enter 发送 · Shift+Enter 换行
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
  onLogin,
  onOpenSimple,
  onOpenExpert,
}: {
  loginRequired: boolean;
  onLogin: () => void;
  onOpenSimple: () => void;
  onOpenExpert: () => void;
}) {
  return (
    <div className="space-y-2.5">
      <div className="text-center">
        <h1 className="font-display text-[28px] font-semibold tracking-tight text-ink sm:text-[34px]">
          FateClaw · 守义
        </h1>
        <p className="mt-1 text-[12px] text-muted">AI 排盘与对话工作台</p>
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
                  登录后开始体验
                </span>
                <span className="mt-1 block text-[12px] leading-5 text-muted">
                  登录后可进入专家模式、保存对话记录，并查看可用余额和用量。
                </span>
              </span>
            </span>
            <button
              type="button"
              onClick={onLogin}
              className="inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-xl bg-primary px-4 text-[13px] font-semibold text-on-primary shadow-sm transition-colors hover:bg-primary-active focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35"
            >
              <LogIn size={14} />
              立即登录
            </button>
          </div>
        </div>
      )}

      <div className="grid gap-2.5 sm:grid-cols-2">
        <button
          type="button"
          onClick={onOpenSimple}
          className="group flex min-h-[164px] flex-col justify-between rounded-2xl border border-hairline bg-surface-card/65 p-4 text-left transition-all duration-200 hover:border-primary/35 hover:bg-surface-cream-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35"
        >
          <span className="flex items-start justify-between gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-surface-cream-strong text-muted">
              <Workflow size={18} />
            </span>
            <span className="rounded-full border border-hairline bg-surface-card px-2 py-0.5 text-[10px] font-medium text-muted">
              新手友好
            </span>
          </span>

          <span className="mt-5 block space-y-1">
            <span className="block text-[17px] font-semibold text-ink">
              简易模式
            </span>
            <span className="block text-[12px] leading-5 text-muted">
              适合新手和非从业者，后续会用流程一步步引导提问和排盘。
            </span>
          </span>

          <span className="mt-4 inline-flex items-center gap-1.5 text-[12px] font-medium text-muted">
            进入简易模式
            <ChevronRight
              size={13}
              className="transition-transform duration-200 group-hover:translate-x-0.5"
            />
          </span>
        </button>

        <button
          type="button"
          onClick={onOpenExpert}
          className="group flex min-h-[164px] flex-col justify-between rounded-2xl border border-primary/25 bg-[linear-gradient(180deg,rgba(204,120,92,0.1),rgba(255,255,255,0.02))] p-4 text-left shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/45 hover:bg-primary/12 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 active:scale-[0.99]"
        >
          <span className="flex items-start justify-between gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/14 text-primary">
              <Compass size={18} />
            </span>
            <span className="inline-flex items-center gap-1 rounded-full border border-primary bg-primary px-2 py-1 text-[10px] font-semibold text-on-primary shadow-sm">
              <CheckCircle2 size={11} strokeWidth={2} />
              立即可用
            </span>
          </span>

          <span className="mt-5 block space-y-1">
            <span className="block text-[17px] font-semibold text-ink">
              专家模式
            </span>
            <span className="block text-[12px] leading-5 text-muted">
              适合懂术数、从业者和专业人士，可直接使用完整对话与排盘能力。
            </span>
          </span>

          <span className="mt-4 inline-flex items-center gap-1.5 text-[12px] font-medium text-primary">
            进入专家模式
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

function ExpertModeFrame({
  children,
  onBack,
}: {
  children: ReactNode;
  onBack: () => void;
}) {
  return (
    <div className="space-y-2.5">
      <div className="flex justify-start">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-hairline bg-surface-card/60 px-3 text-[12px] font-medium text-muted transition-colors hover:border-primary/30 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35"
        >
          <ArrowLeft size={13} />
          返回模式选择
        </button>
      </div>
      {children}
    </div>
  );
}

function AiChatFloatingStatus({ status }: { status: ReplyStatus }) {
  const statusLabel = status === 'completed' ? '回答完成' : '已停止输出';
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
            继续完成启动向导
          </span>
          <span className="block truncate text-[10px] text-muted">
            选择官方模型，并启用一个 Skill 后即可开始
          </span>
        </span>
      </span>
      <ChevronRight size={14} className="shrink-0 text-primary" />
    </button>
  );
}

function ChatToolStrip({
  catalog,
  loading,
  disabled,
  onOpenAll,
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
  catalog: PaipanCatalogItem[];
  loading: boolean;
  disabled?: boolean;
  onOpenAll: () => void;
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
  const [openPicker, setOpenPicker] = useState<'model' | 'thinking' | null>(
    null,
  );
  const stripRef = useRef<HTMLDivElement | null>(null);
  const isEmpty = !loading && catalog.length === 0;
  const buttonDisabled = disabled || loading || isEmpty;
  const chipClass =
    'group inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-hairline bg-[linear-gradient(180deg,rgba(255,255,255,0.055),rgba(255,255,255,0.018))] px-2.5 text-[12px] font-medium text-ink shadow-[0_1px_0_rgba(255,255,255,0.04)_inset] transition-colors duration-150 hover:border-primary/30 hover:bg-primary/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 disabled:cursor-not-allowed disabled:bg-surface-card/40 disabled:text-muted disabled:opacity-60';

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
    <div ref={stripRef} className="flex min-h-8 items-center gap-1.5">
      <button
        type="button"
        onClick={onOpenAll}
        disabled={buttonDisabled}
        title="合参术数"
        className={chipClass}
        aria-label="合参术数"
      >
        {loading ? (
          <Loader2 size={13} className="shrink-0 animate-spin text-primary" />
        ) : (
          <Sparkles size={13} className="shrink-0 text-primary" />
        )}
        <span className="whitespace-nowrap">合参术数</span>
        <ChevronRight
          size={12}
          className="shrink-0 text-muted transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-primary group-disabled:translate-x-0 group-disabled:text-muted"
        />
      </button>

      <div className="relative shrink-0">
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
          aria-label={`选择官方模型，当前 ${modelLabel}`}
        >
          {modelLoading || modelBusy ? (
            <Loader2 size={13} className="shrink-0 animate-spin text-primary" />
          ) : (
            <Bot size={13} className="shrink-0 text-primary" />
          )}
          <span className="whitespace-nowrap">模型</span>
          <span className="max-w-[96px] truncate text-muted group-hover:text-primary">
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
              官方模型
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

      <div className="relative shrink-0">
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
          aria-label={`选择思考等级，当前 ${thinkingLabel}`}
        >
          {thinkingBusy ? (
            <Loader2 size={13} className="shrink-0 animate-spin text-primary" />
          ) : (
            <Brain size={13} className="shrink-0 text-primary" />
          )}
          <span className="whitespace-nowrap">思考</span>
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
                  <span>{option.label}</span>
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
