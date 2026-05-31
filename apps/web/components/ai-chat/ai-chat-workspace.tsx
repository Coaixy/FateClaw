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
import {
  CheckCircle2,
  ChevronRight,
  ClipboardPaste,
  Loader2,
  Sparkles,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { AiChatComposer } from '@/components/ai-chat/ai-chat-composer';
import { AiChatMessageList } from '@/components/ai-chat/ai-chat-message-list';
import { PaipanSheet } from '@/components/ai-chat/paipan-sheet';
import { PaipanSkillPickerSheet } from '@/components/ai-chat/paipan-skill-picker-sheet';
import { PaipanSkillRail } from '@/components/ai-chat/paipan-skill-rail';
import { PastedBoardSheet } from '@/components/ai-chat/pasted-board-sheet';
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
import { buildLoginHref } from '@/lib/auth-redirect';
import { useToast } from '@/lib/use-toast';

type PaipanSheetMode = 'pre-chat' | 'current-session';
type PasteChoiceSelection = {
  readonly start: number;
  readonly end: number;
};
type PastedBoardDraftSource = 'composer' | 'paste' | 'manual';
const PENDING_CHAT_INPUT_KEY = 'fateclaw:ai-chat:pending-input';

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
  const [replyCompleted, setReplyCompleted] = useState(false);
  const wasSendingRef = useRef(false);

  const chatMessages = useChatMessages({
    chatAvailable,
    selectedSession,
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
    let cancelled = false;
    setPaipanCatalog([]);
    setPaipanCatalogLoading(true);

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

    return () => {
      cancelled = true;
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

      await chatMessages.sendMessageWithOptions(text);
    },
    [
      chatAvailable,
      chatMessages,
      continuationBlocked,
      authLoading,
      input,
      requestLogin,
    ],
  );

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
  const showCenteredComposer =
    !selectedSession ||
    (!chatMessages.loading &&
      !chatMessages.sending &&
      displayMessages.length === 0);

  useEffect(() => {
    if (chatMessages.sending) {
      wasSendingRef.current = true;
      setReplyCompleted(false);
      return;
    }

    if (wasSendingRef.current) {
      wasSendingRef.current = false;
      setReplyCompleted(true);
    }
  }, [chatMessages.sending]);

  useEffect(() => {
    if (!chatMessages.sending) {
      wasSendingRef.current = false;
      setReplyCompleted(false);
    }
  }, [chatMessages.sending, selectedSession]);

  useEffect(() => {
    if (!replyCompleted) return;

    const timeoutId = window.setTimeout(() => {
      setReplyCompleted(false);
    }, 2400);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [replyCompleted]);

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
          showCenteredComposer={showCenteredComposer}
          composer={showCenteredComposer ? centeredComposer : composer}
        />
        {!showCenteredComposer && replyCompleted && (
          <AiChatFloatingStatus completed={replyCompleted} />
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
            <p className="block text-[9px] text-muted/40 text-center mt-1.5 select-none">
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

function AiChatFloatingStatus({ completed }: { completed: boolean }) {
  const statusLabel = completed ? '回答完成' : null;

  if (!statusLabel) return null;

  return (
    <div className="pointer-events-none sticky bottom-2 z-10 mt-2 flex justify-center px-3">
      <span className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-hairline bg-surface-card/95 px-2.5 text-[10px] text-muted shadow-sm backdrop-blur transition-colors">
        <CheckCircle2 size={12} />
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
      className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-hairline bg-surface-card px-2 text-[10px] font-medium text-muted transition-colors hover:border-primary/30 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 disabled:cursor-not-allowed disabled:opacity-40"
      aria-label="自贴盘面"
    >
      <ClipboardPaste size={11} />
      自贴盘面
    </button>
  );

  if (loading) {
    return (
      <div className="flex h-8 items-center gap-1.5 rounded-lg border border-hairline bg-surface-card/60 px-2.5 text-[10px] text-muted">
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
      <div className="flex h-8 items-center gap-1.5 rounded-lg border border-dashed border-hairline bg-surface-card/35 px-2.5 text-[10px] text-muted">
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <Sparkles size={12} className="shrink-0" />
          <span className="truncate">当前暂无可用术数</span>
        </span>
        {pastedBoardButton}
      </div>
    );
  }

  return (
    <div className="flex h-8 items-center gap-1.5 overflow-x-auto scrollbar-hide rounded-lg border border-hairline bg-surface-card/55 px-1.5 py-1">
      <span className="sticky left-0 z-[1] inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-surface-card px-1.5 text-[10px] font-medium text-muted">
        <Sparkles size={11} />
        术数
      </span>
      {pastedBoardButton}
      <span className="h-4 w-px shrink-0 bg-hairline/70" />
      {catalog.map((item) => (
        <button
          key={item.skill}
          type="button"
          onClick={() => onSelectSkill(item.skill)}
          disabled={disabled}
          className="inline-flex h-6 shrink-0 items-center rounded-md border border-transparent px-2 text-[11px] font-medium text-ink transition-colors hover:border-primary/25 hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {item.name}
        </button>
      ))}
      <button
        type="button"
        onClick={onOpenAll}
        disabled={disabled}
        className="inline-flex h-6 shrink-0 items-center gap-0.5 rounded-md border border-hairline bg-surface-card px-2 text-[10px] text-muted transition-colors hover:border-primary/30 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 disabled:cursor-not-allowed disabled:opacity-40"
      >
        更多
        <ChevronRight size={11} />
      </button>
    </div>
  );
}
