'use client';

import {
  Suspense,
  type ClipboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import {
  CheckCircle2,
  ChevronRight,
  CircleStop,
  ClipboardPaste,
  Loader2,
  Sparkles,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { AiChatComposer } from '@/components/ai-chat/ai-chat-composer';
import { AiChatMessageList } from '@/components/ai-chat/ai-chat-message-list';
import {
  PaipanSkillRail,
  type EnabledSkillSummary,
} from '@/components/ai-chat/paipan-skill-rail';
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
import { skillsApi } from '@/features/skills/api';
import { buildLoginHref } from '@/lib/auth-redirect';
import { useToast } from '@/lib/use-toast';

type PaipanSheetMode = 'pre-chat' | 'current-session';
type PasteChoiceSelection = {
  readonly start: number;
  readonly end: number;
};
type PastedBoardDraftSource = 'composer' | 'paste' | 'manual';
type ReplyStatus = 'completed' | 'interrupted';
const PENDING_CHAT_INPUT_KEY = 'fateclaw:ai-chat:pending-input';
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
  const { loading: authLoading } = useAuth();
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
  const [enabledSkills, setEnabledSkills] = useState<EnabledSkillSummary[]>([]);
  const [enabledSkillsLoading, setEnabledSkillsLoading] = useState(false);
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
  const [replyStatus, setReplyStatus] = useState<ReplyStatus | null>(null);
  const wasSendingRef = useRef(false);
  const stopRequestedRef = useRef(false);

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

  useEffect(() => {
    if (!chatAvailable) {
      setEnabledSkills([]);
      setEnabledSkillsLoading(false);
      return;
    }

    let cancelled = false;
    setEnabledSkillsLoading(true);

    const cancelIdleTask = scheduleIdleTask(() => {
      if (cancelled) return;

      // AI 对话首页只展示已开启 Skill 摘要，具体启停仍在 Studio 中管理。
      void skillsApi
        .userList()
        .then((result) => {
          if (cancelled) return;
          setEnabledSkills([
            ...(result.own ?? [])
              .filter((skill) => skill.enabled)
              .map((skill) => ({
                id: skill.id,
                name: skill.skill_name,
                source: 'own' as const,
              })),
            ...(result.subscribed ?? [])
              .filter((skill) => skill.subscription_enabled)
              .map((skill) => ({
                id: skill.subscription_id,
                name: skill.skill_name,
                source: 'subscribed' as const,
              })),
          ]);
        })
        .catch((error) => {
          if (cancelled) return;
          setEnabledSkills([]);
          toast(
            'error',
            error instanceof Error ? error.message : '加载已开启 Skill 失败',
          );
        })
        .finally(() => {
          if (!cancelled) {
            setEnabledSkillsLoading(false);
          }
        });
    });

    return () => {
      cancelled = true;
      cancelIdleTask();
    };
  }, [chatAvailable, toast]);

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
      if (
        chatMessages.sending ||
        continuationBlocked ||
        !chatAvailable
      ) {
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
    [
      authLoading,
      continuationBlocked,
      continuationBlockedMessage,
      toast,
    ],
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

  const centeredComposer = (
    <div className="space-y-2.5">
      {composer}
      {selectedSession ? (
        <PaipanSkillStrip
          catalog={paipanCatalog}
          loading={paipanCatalogLoading}
          disabled={
            authLoading ||
            chatMessages.sending ||
            continuationBlocked
          }
          onSelectSkill={(skill) => openCurrentSessionPaipan(skill)}
          onOpenAll={() => openCurrentSessionPaipan()}
          onOpenPastedBoard={handleOpenComposerPastedBoard}
          pastedBoardDisabled={pastedBoardDisabled}
        />
      ) : (
        <PaipanSkillRail
          catalog={paipanCatalog}
          loading={paipanCatalogLoading}
          enabledSkills={enabledSkills}
          enabledSkillsLoading={enabledSkillsLoading}
          disabled={authLoading || chatMessages.sending}
          pastedBoardDisabled={pastedBoardDisabled}
          onSelectSkill={(skill) => openPreChatPaipan(skill)}
          onOpenAll={openPaipanSkillPicker}
          onOpenPastedBoard={handleOpenComposerPastedBoard}
        />
      )}
    </div>
  );

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
          composer={showCenteredComposer ? centeredComposer : composer}
        />
        {!showCenteredComposer && replyStatus && (
          <AiChatFloatingStatus status={replyStatus} />
        )}
      </div>

      {!showCenteredComposer && (
        <div className="shrink-0 pt-1.5 pb-1">
          <div className="max-w-2xl mx-auto px-2.5 sm:px-3">
            <div className="mb-1.5">
              <PaipanSkillStrip
                catalog={paipanCatalog}
                loading={paipanCatalogLoading}
                disabled={
                  authLoading ||
                  chatMessages.sending ||
                  continuationBlocked ||
                  !selectedSession
                }
                onSelectSkill={(skill) => openCurrentSessionPaipan(skill)}
                onOpenAll={() => openCurrentSessionPaipan()}
                onOpenPastedBoard={handleOpenComposerPastedBoard}
                pastedBoardDisabled={pastedBoardDisabled}
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
          (paipanSheetMode !== 'current-session' ||
            !continuationBlocked)
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

function PaipanSkillStrip({
  catalog,
  loading,
  disabled,
  onSelectSkill,
  onOpenAll,
  onOpenPastedBoard,
  pastedBoardDisabled,
}: {
  catalog: PaipanCatalogItem[];
  loading: boolean;
  disabled?: boolean;
  onSelectSkill: (skill: string) => void;
  onOpenAll: () => void;
  onOpenPastedBoard: () => void;
  pastedBoardDisabled?: boolean;
}) {
  const isEmpty = !loading && catalog.length === 0;
  const pastedBoardButton = (
    <button
      type="button"
      onClick={onOpenPastedBoard}
      disabled={pastedBoardDisabled}
      className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-hairline bg-surface-card px-2 text-[11px] font-medium text-muted transition-colors hover:border-primary/30 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 disabled:cursor-not-allowed disabled:opacity-40"
      aria-label="自贴盘面"
    >
      <ClipboardPaste size={12} />
      自贴盘面
    </button>
  );

  if (loading) {
    return (
      <div className="flex h-9 items-center gap-1.5 rounded-lg border border-hairline bg-surface-card/60 px-2.5 text-[11px] text-muted">
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <Loader2 size={12} className="shrink-0 animate-spin" />
          <span className="truncate">正在加载术数...</span>
        </span>
        {pastedBoardButton}
      </div>
    );
  }

  if (isEmpty) {
    return (
      <div className="flex h-9 items-center gap-1.5 rounded-lg border border-dashed border-hairline bg-surface-card/35 px-2.5 text-[11px] text-muted">
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <Sparkles size={12} className="shrink-0" />
          <span className="truncate">当前暂无可用术数</span>
        </span>
        {pastedBoardButton}
      </div>
    );
  }

  return (
    <div className="relative">
      <div className="flex h-9 items-center gap-1.5 overflow-x-auto scrollbar-hide rounded-lg border border-hairline bg-surface-card/55 px-1.5 py-1 pr-6">
        <span className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-primary/10 px-1.5 text-[11px] font-medium text-primary">
          <Sparkles size={12} />
          术数
        </span>
        {catalog.map((item) => (
          <button
            key={item.skill}
            type="button"
            onClick={() => onSelectSkill(item.skill)}
            disabled={disabled}
            className="inline-flex h-7 shrink-0 items-center rounded-md border border-primary/10 bg-surface-card/55 px-2 text-[12px] font-medium text-ink transition-colors hover:border-primary/25 hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {item.name}
          </button>
        ))}
        <button
          type="button"
          onClick={onOpenAll}
          disabled={disabled}
          className="inline-flex h-7 shrink-0 items-center gap-0.5 rounded-md border border-hairline bg-surface-card px-2 text-[11px] text-muted transition-colors hover:border-primary/30 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 disabled:cursor-not-allowed disabled:opacity-40"
        >
          更多
          <ChevronRight size={11} />
        </button>
        <span className="h-4 w-px shrink-0 bg-hairline/70" />
        {pastedBoardButton}
      </div>
      <div className="pointer-events-none absolute inset-y-px right-px w-8 rounded-r-lg bg-gradient-to-l from-surface-card/95 to-transparent" />
    </div>
  );
}
