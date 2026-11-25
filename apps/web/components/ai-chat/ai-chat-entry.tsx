'use client';

import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AppShell } from '@/components/app-shell';
import {
  PENDING_CHAT_INPUT_KEY,
  useChatSessions,
} from '@/features/chat/hooks/use-chat-sessions';
import { useI18n } from '@/lib/i18n';
import { buildGuideReturnQuery } from '@/lib/return-to';
import {
  AiChatEmptyState,
  NewChatStartChoice,
  type NewChatStartMode,
} from './ai-chat-start';
import { useOnboardingGuideStatus } from './use-onboarding-guide-status';

const AiChatWorkspace = lazy(() =>
  import('./ai-chat-workspace').then(({ AiChatWorkspace }) => ({
    default: AiChatWorkspace,
  })),
);

const OnboardingGuideDialog = lazy(() =>
  import('./onboarding-guide-dialog').then(({ OnboardingGuideDialog }) => ({
    default: OnboardingGuideDialog,
  })),
);

export function AiChatEntry() {
  return (
    <AppShell wide noPadding requireAuth={false}>
      <AiChatEntryContent />
    </AppShell>
  );
}

function AiChatEntryContent() {
  const { t } = useI18n();
  const router = useRouter();
  const { chatAvailable, selectedSession, selectedSessionRevision } =
    useChatSessions();
  const [clientId, setClientId] = useState<string | null>(null);
  const [workspaceOpened, setWorkspaceOpened] = useState(false);
  const [start, setStart] = useState<{
    mode: NewChatStartMode;
    revision: number;
  } | null>(null);
  const guide = useOnboardingGuideStatus({ enabled: chatAvailable });

  const setStartMode = useCallback(
    (mode: NewChatStartMode) => {
      setStart({ mode, revision: selectedSessionRevision });
      setWorkspaceOpened(true);
    },
    [selectedSessionRevision],
  );

  useEffect(() => {
    if (selectedSession || clientId) setWorkspaceOpened(true);
  }, [selectedSession, clientId]);

  useEffect(() => {
    if (chatAvailable && window.sessionStorage.getItem(PENDING_CHAT_INPUT_KEY)) {
      setWorkspaceOpened(true);
    }
  }, [chatAvailable]);

  // A new selection revision resets the chooser even if there was no selected session.
  const startMode =
    start?.revision === selectedSessionRevision ? start.mode : 'choice';

  return (
    <>
      <Suspense fallback={null}>
        <ChatClientParam onChange={setClientId} />
      </Suspense>
      {workspaceOpened || selectedSession || clientId ? (
        <Suspense
          fallback={
            <div
              role="status"
              className="grid flex-1 place-items-center text-sm text-muted"
            >
              {t('common.loading')}
            </div>
          }
        >
          <AiChatWorkspace
            startMode={startMode}
            setStartMode={setStartMode}
            clientId={clientId}
            onOpenGuide={
              guide.shouldShowContinueEntry ? guide.openGuide : undefined
            }
          />
        </Suspense>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col pt-1.5 lg:pt-0">
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-3 lg:py-5">
            <AiChatEmptyState
              title={t('aiChat.start.title')}
              description={t('aiChat.start.description')}
              frameClassName="justify-center pb-12"
            >
              <NewChatStartChoice
                onChoosePaipan={() => setStartMode('paipan')}
                onChoosePlain={() => setStartMode('plain')}
              />
            </AiChatEmptyState>
          </div>
        </div>
      )}
      {guide.open && (
        <Suspense fallback={null}>
          <OnboardingGuideDialog
            open
            step={guide.step}
            modelReady={guide.modelReady}
            modelMembershipRequired={guide.modelMembershipRequired}
            skillReady={guide.skillReady}
            modelLoading={guide.modelLoading}
            skillLoading={guide.skillLoading}
            modelError={guide.modelError}
            skillError={guide.skillError}
            hasAnyInstalledSkill={guide.hasAnyInstalledSkill}
            onClose={guide.dismissGuide}
            onSaveStep={guide.saveStep}
            onRetry={() => void guide.refresh()}
            onOpenSkillMarket={() => {
              guide.saveStep('skill');
              router.push(`/discover?${buildGuideReturnQuery('/ai-chat')}`);
            }}
            onComplete={guide.completeGuide}
          />
        </Suspense>
      )}
    </>
  );
}

function ChatClientParam({ onChange }: { onChange: (id: string | null) => void }) {
  const clientId = useSearchParams().get('client');
  useEffect(() => onChange(clientId), [clientId, onChange]);
  return null;
}
