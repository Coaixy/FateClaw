'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Brain,
  ChevronDown,
  Crown,
  Wrench,
} from 'lucide-react';

import { ArtifactDebug } from '@/components/chat/artifact-debug';
import { ArtifactRenderer } from '@/components/chat/artifact-renderer';
import { ChatLoadingState } from '@/components/chat/chat-loading-state';
import { CollapsibleMessage } from '@/components/chat/collapsible-message';
import { MessageFooter } from '@/components/chat/message-footer';
import { Message } from '@/features/chat/api';
import { useI18n } from '@/lib/i18n';
import { sanitizeToolPath } from '@/features/chat/utils/tool-path';
import {
  PAIPAN_SKILLS,
  canHostToolTraceFooter,
  formatChatCostLabels,
  formatChatDuration,
  hasFinalAssistantAfterLatestUser,
  isKnowledgeTrajectoryMessage,
  isStreamingAssistantMessage,
  isThinkingMessage,
  isToolTraceMessage,
} from '@/features/chat/utils/display';
import { parseToolContext } from '@/features/chat/utils/tool-context';
import { splitFinalTurnMarker } from '@/features/chat/utils/markers';

type AiChatBillingNotice = 'arrears' | 'plus-required';

export function AiChatMessageList({
  messages,
  loading,
  sending,
  progressLabel,
  selectedSession,
  switchingSession,
  showCenteredComposer,
  latestMessageNotice,
  composer,
  emptyStateTitle,
  emptyStateDescription,
  emptyStateHint,
  emptyStateFrameClassName,
  emptyStateMaxWidthClassName,
}: {
  messages: Message[];
  loading: boolean;
  sending: boolean;
  progressLabel: string | null;
  selectedSession: string;
  switchingSession: boolean;
  showCenteredComposer: boolean;
  latestMessageNotice?: AiChatBillingNotice | null;
  composer: React.ReactNode;
  emptyStateTitle?: string;
  emptyStateDescription?: string;
  emptyStateHint?: string;
  emptyStateFrameClassName?: string;
  emptyStateMaxWidthClassName?: string;
}) {
  const { t } = useI18n();
  const latestMessageNoticeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!latestMessageNotice) return;

    const frame = window.requestAnimationFrame(() => {
      latestMessageNoticeRef.current?.scrollIntoView({ block: 'nearest' });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [latestMessageNotice]);

  if (showCenteredComposer) {
    const title = emptyStateTitle ?? t('aiChat.empty.defaultTitle');
    const description =
      emptyStateDescription ?? t('aiChat.empty.defaultDescription');
    const hint =
      emptyStateHint ??
      (selectedSession
        ? t('aiChat.empty.selectedHint')
        : t('aiChat.empty.newHint'));

    return (
      <div
        className={`flex h-full flex-col items-center px-3 ${
          emptyStateFrameClassName ?? 'justify-center'
        }`}
      >
        <div
          className={`w-full ${emptyStateMaxWidthClassName ?? 'max-w-xl'} flex flex-col items-center gap-3.5`}
        >
          <BaguaPattern />
          {(title || description) && (
            <div className="text-center space-y-1">
              {title && (
                <h1 className="font-display text-[18px] sm:text-[20px] lg:text-[22px] font-semibold tracking-tight text-ink">
                  {title}
                </h1>
              )}
              {description && (
                <p className="text-[12px] sm:text-[13px] text-muted">
                  {description}
                </p>
              )}
            </div>
          )}
          <div className="w-full">{composer}</div>
          {hint && (
            <p className="text-center text-[10px] sm:text-[11px] text-muted/50 select-none">
              {hint}
            </p>
          )}
        </div>
      </div>
    );
  }

  if (loading && messages.length === 0 && !sending) {
    return <ChatLoadingState count={3} />;
  }

  if (switchingSession) {
    return <ChatLoadingState count={4} />;
  }

  const { rows, pendingToolTraces } = buildDisplayRows(messages);
  const hasStreamingAssistantMessage = messages.some(
    isStreamingAssistantMessage,
  );
  const hasThinkingMessage = messages.some(isThinkingMessage);
  const hasCompletedAssistantTurn = hasFinalAssistantAfterLatestUser(messages);
  const showThinkingIndicator =
    !hasCompletedAssistantTurn &&
    sending &&
    ((!hasStreamingAssistantMessage && !hasThinkingMessage) ||
      pendingToolTraces.length > 0);

  return (
    <div className="px-1.5 lg:px-3 space-y-2.5 lg:space-y-3">
      {rows.map(({ message, toolTraces }, index) => (
        <AiChatMessageRow
          key={message.id}
          message={message}
          toolTraces={toolTraces}
          animationIndex={index}
        />
      ))}

      {rows.length > 0 && latestMessageNotice && (
        <LatestMessageBillingNotice
          notice={latestMessageNotice}
          containerRef={latestMessageNoticeRef}
        />
      )}

      {showThinkingIndicator && (
        <ThinkingIndicator
          progressLabel={progressLabel}
          toolTraces={pendingToolTraces}
        />
      )}
    </div>
  );
}

function buildDisplayRows(messages: Message[]) {
  const rows: Array<{ message: Message; toolTraces: Message[] }> = [];
  let pendingToolTraces: Message[] = [];
  let latestToolTraceHostIndex: number | null = null;

  // tool 事件可能出现在回复文本之前或之后；统一收束到最近的真实 AI 回复底部。
  const attachPendingToolTracesToLatestHost = () => {
    if (
      pendingToolTraces.length === 0 ||
      latestToolTraceHostIndex === null
    ) {
      return;
    }

    const hostRow = rows[latestToolTraceHostIndex];
    rows[latestToolTraceHostIndex] = {
      ...hostRow,
      toolTraces: [...hostRow.toolTraces, ...pendingToolTraces],
    };
    pendingToolTraces = [];
  };

  for (const message of messages) {
    if (message.is_bot_message && isToolTraceMessage(message)) {
      pendingToolTraces = [...pendingToolTraces, message];
      continue;
    }

    if (!message.is_bot_message) {
      attachPendingToolTracesToLatestHost();
      latestToolTraceHostIndex = null;
      rows.push({ message, toolTraces: [] });
      continue;
    }

    const canAttachToolTraces = canHostToolTraceFooter(message);
    rows.push({
      message,
      toolTraces: canAttachToolTraces ? pendingToolTraces : [],
    });
    if (canAttachToolTraces) {
      pendingToolTraces = [];
      latestToolTraceHostIndex = rows.length - 1;
    }
  }

  attachPendingToolTracesToLatestHost();

  return { rows, pendingToolTraces };
}

function LatestMessageBillingNotice({
  notice,
  containerRef,
}: {
  notice: AiChatBillingNotice;
  containerRef: React.Ref<HTMLDivElement>;
}) {
  const { t } = useI18n();
  const isArrears = notice === 'arrears';
  const titleKey = isArrears
    ? 'aiChat.messageList.billingNoticeArrearsTitle'
    : 'aiChat.messageList.billingNoticePlusTitle';
  const descriptionKey = isArrears
    ? 'aiChat.messageList.billingNoticeArrearsDescription'
    : 'aiChat.messageList.billingNoticePlusDescription';

  return (
    <div
      ref={containerRef}
      className="max-w-2xl mx-auto flex justify-start animate-message-in"
    >
      <div className="flex min-w-0 max-w-[88%] flex-col items-start sm:max-w-[78%]">
        <div
          role="status"
          aria-live="polite"
          className={`max-w-full rounded-xl border px-3 py-2 shadow-sm ${
            isArrears
              ? 'border-error/25 bg-error/8 text-error'
              : 'border-primary/25 bg-primary/8 text-primary'
          }`}
        >
          <div className="flex items-start gap-2">
            <AlertCircle
              size={15}
              strokeWidth={1.8}
              aria-hidden="true"
              className="mt-1 shrink-0"
            />
            <div className="min-w-0">
              <p className="text-[12px] font-semibold leading-5">
                {t(titleKey)}
              </p>
              <p className="mt-0.5 text-[12px] leading-5 text-ink/70">
                {t(descriptionKey)}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Link
                  href="/membership"
                  className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-[12px] font-medium text-on-primary shadow-sm transition-colors hover:bg-primary-active"
                >
                  <Crown size={12} aria-hidden="true" />
                  {t(
                    isArrears
                      ? 'aiChat.messageList.membershipCenter'
                      : 'aiChat.messageList.openPlus',
                  )}
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function shouldShowWalletRecovery(content: string) {
  return /余额已欠费|积分已欠费|充值后继续使用|补充积分后继续使用|余额不足|积分不足|欠费/.test(
    content,
  );
}

function AiChatMessageRow({
  message,
  toolTraces,
  animationIndex,
}: {
  message: Message;
  toolTraces: Message[];
  animationIndex: number;
}) {
  const { locale, t } = useI18n();
  const isBot = !!message.is_bot_message;
  const messageMetadata =
    !!message.metadata &&
    typeof message.metadata === 'object' &&
    !Array.isArray(message.metadata)
      ? message.metadata
      : null;
  const isErrorMessage = isBot && messageMetadata?.kind === 'error';
  const isThinkingBubble = isBot && isThinkingMessage(message);
  const isFinalMessage = messageMetadata?.kind === 'final' || isErrorMessage;
  const { body: displayContent } = isBot
    ? splitFinalTurnMarker(message.content)
    : { body: message.content };
  const durationLabel = isBot
    ? formatChatDuration(messageMetadata?.duration_ms, t)
    : null;
  const costLabels = isBot ? formatChatCostLabels(messageMetadata, locale, t) : [];
  const toolContext = isBot ? parseToolContext(message.tool_context) : [];
  const hasChart =
    isBot && toolContext.some((entry) => PAIPAN_SKILLS.has(entry.skill));
  const showWalletRecovery =
    isErrorMessage && shouldShowWalletRecovery(displayContent);

  // 知识检索轨迹：紧凑时间线样式
  if (isBot && isKnowledgeTrajectoryMessage(message)) {
    const stage = messageMetadata?.stage as string | undefined;
    const isSectionRead = stage === 'knowledge_section';
    return (
      <div
        className="max-w-2xl mx-auto flex items-center gap-2 animate-message-in"
        style={{ animationDelay: `${Math.min(animationIndex * 30, 120)}ms` }}
      >
        <div
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${
            stage === 'knowledge_hit'
              ? 'bg-primary'
              : isSectionRead
                ? 'bg-primary/50'
                : 'bg-muted'
          }`}
        />
        <span
          className={`text-[11px] sm:text-[12px] ${
            stage === 'knowledge_hit'
              ? 'text-primary font-medium'
              : 'text-muted'
          }`}
        >
          {displayContent}
        </span>
      </div>
    );
  }

  if (isThinkingBubble) {
    return (
      <ThinkingMessageBox
        content={displayContent}
        animationIndex={animationIndex}
      />
    );
  }

  if (hasChart && !isFinalMessage) {
    return (
      <div
        className="w-full max-w-6xl mx-auto animate-message-in"
        style={{ animationDelay: `${Math.min(animationIndex * 50, 200)}ms` }}
      >
        <ArtifactRenderer entries={toolContext} />
        <ArtifactDebug entries={toolContext} />
        {toolTraces.length > 0 && <ToolTraceList messages={toolTraces} />}
        <MessageFooter
          isBot={isBot}
          durationLabel={durationLabel}
          costLabels={costLabels}
        />
      </div>
    );
  }

  return (
    <div
      className={`max-w-2xl mx-auto flex animate-message-in ${
        isBot ? 'justify-start' : 'justify-end'
      }`}
      style={{ animationDelay: `${Math.min(animationIndex * 50, 200)}ms` }}
    >
      <div
        className={`flex min-w-0 max-w-[88%] flex-col ${
          isBot ? 'items-start sm:max-w-[78%]' : 'items-end sm:max-w-[74%]'
        }`}
      >
        <div className="group relative max-w-full">
          <div
            role={isErrorMessage ? 'alert' : undefined}
            className={`rounded-xl px-3.5 py-2.5 text-[14px] leading-7 transition-shadow duration-200 ${
              isBot
                ? isErrorMessage
                  ? 'border border-error/30 bg-error/8 text-error shadow-sm'
                  : 'bg-surface-card border border-hairline shadow-sm hover:shadow-md'
                : 'bg-surface-dark text-on-dark shadow-sm'
            }`}
          >
            <CollapsibleMessage content={displayContent} isBot={isBot} />
          </div>
          {showWalletRecovery ? (
            <div className="mt-2 flex flex-wrap gap-2">
              <Link
                href="/membership"
                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-[12px] font-medium text-on-primary shadow-sm transition-colors hover:bg-primary-active"
              >
                <Crown size={12} />
                {t('aiChat.messageList.membershipCenter')}
              </Link>
            </div>
          ) : null}
        </div>

        {isBot && !isFinalMessage && toolContext.length > 0 && (
          <div className="w-full max-w-full sm:max-w-[90%] mt-1">
            <ArtifactRenderer entries={toolContext} />
            <ArtifactDebug entries={toolContext} />
          </div>
        )}

        {isBot && toolTraces.length > 0 && (
          <ToolTraceList
            messages={toolTraces}
            forceComplete={isFinalMessage}
          />
        )}

        <MessageFooter
          isBot={isBot}
          durationLabel={durationLabel}
          costLabels={costLabels}
        />
      </div>
    </div>
  );
}

function ThinkingMessageBox({
  content,
  animationIndex,
}: {
  content: string;
  animationIndex: number;
}) {
  const { t } = useI18n();
  const displayContent = content.trim() || t('aiChat.messageList.thinkingFallback');

  return (
    <div
      className="max-w-2xl mx-auto flex justify-start animate-message-in"
      style={{ animationDelay: `${Math.min(animationIndex * 30, 120)}ms` }}
    >
      <div className="flex min-w-0 max-w-[82%] flex-col items-start sm:max-w-[62%]">
        <div className="max-w-full overflow-hidden rounded-lg border border-hairline bg-surface-card/80 px-2.5 py-2 shadow-sm">
          <div className="mb-1 flex items-center gap-1.5 text-[10px] font-medium leading-4 text-muted-soft">
            <Brain size={11} strokeWidth={1.8} aria-hidden="true" />
            <span>{t('aiChat.messageList.thinking')}</span>
          </div>
          <div className="thinking-scrollbar max-h-24 overflow-y-auto overscroll-contain pr-1 text-[11px] leading-5 text-muted whitespace-pre-wrap break-words">
            {displayContent}
          </div>
        </div>
      </div>
    </div>
  );
}

type ToolTraceStatus = 'running' | 'completed' | 'failed' | undefined;

function getToolTraceStatusLabel(status: ToolTraceStatus) {
  if (status === 'running') return 'aiChat.messageList.toolStatusRunning';
  if (status === 'completed') return 'aiChat.messageList.toolStatusCompleted';
  if (status === 'failed') return 'aiChat.messageList.toolStatusFailed';
  return 'aiChat.messageList.toolStatusUnknown';
}

function ToolTraceList({
  messages,
  forceComplete = false,
}: {
  messages: Message[];
  forceComplete?: boolean;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const traces = messages.map((message) => {
    const metadata =
      message.metadata &&
      typeof message.metadata === 'object' &&
      !Array.isArray(message.metadata)
        ? message.metadata
        : null;
    const rawStatus = metadata?.tool_status as ToolTraceStatus;
    const status =
      forceComplete && rawStatus === 'running' ? 'completed' : rawStatus;
    const path =
      typeof metadata?.tool_path === 'string'
        ? sanitizeToolPath(metadata.tool_path)
        : undefined;
    const label =
      (metadata?.tool_name as string | undefined) ||
      (metadata?.tool_label as string | undefined) ||
      'tool';

    return {
      id: message.id,
      label,
      path,
      status,
      statusLabel: getToolTraceStatusLabel(status),
    };
  });
  const runningCount = traces.filter((trace) => trace.status === 'running').length;
  const failedCount = traces.filter((trace) => trace.status === 'failed').length;
  const completedCount = traces.filter(
    (trace) => trace.status === 'completed',
  ).length;
  const latestTrace = traces[traces.length - 1];
  const statusSummary =
    runningCount > 0
      ? t('aiChat.messageList.runningCount', { count: runningCount })
      : failedCount > 0
        ? t('aiChat.messageList.failedCount', { count: failedCount })
        : completedCount > 0
          ? t('aiChat.messageList.completedCount', { count: completedCount })
          : t('aiChat.messageList.toolStatusPending');

  return (
    <div className="mt-1 max-w-full">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="group inline-flex min-h-7 max-w-full cursor-pointer items-center gap-1.5 rounded-full border border-hairline/70 bg-surface-card/70 px-2 py-1 text-[10px] font-medium text-muted shadow-sm transition-colors hover:border-primary/30 hover:bg-surface-cream-strong hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
      >
        <Wrench
          size={11}
          strokeWidth={1.8}
          aria-hidden="true"
          className="shrink-0 text-muted-soft group-hover:text-primary"
        />
        <span className="shrink-0">{t('aiChat.messageList.toolTrace')}</span>
        <span className="shrink-0 rounded-full bg-surface-soft px-1.5 py-0.5 tabular-nums text-muted-soft">
          {traces.length}
        </span>
        <span
          className={`shrink-0 rounded-full px-1.5 py-0.5 tabular-nums ${
            runningCount > 0
              ? 'bg-primary/10 text-primary'
              : failedCount > 0
                ? 'bg-error/10 text-error'
                : 'bg-surface-soft text-muted-soft'
          }`}
        >
          {statusSummary}
        </span>
        {latestTrace?.path && (
          <span className="hidden min-w-0 max-w-[180px] truncate font-mono text-[9px] text-muted-soft sm:inline">
            {latestTrace.path}
          </span>
        )}
        <ChevronDown
          size={12}
          strokeWidth={1.8}
          aria-hidden="true"
          className={`shrink-0 text-muted-soft transition-transform duration-150 group-hover:text-primary ${
            expanded ? 'rotate-180' : ''
          }`}
        />
      </button>

      {expanded && (
        <div className="mt-1.5 flex max-w-full flex-col gap-1 rounded-lg border border-hairline/70 bg-surface-card/45 p-1.5 shadow-sm">
          {traces.map((trace) => (
            <div key={trace.id} className="flex min-w-0">
              <div className="min-w-0 flex flex-wrap items-center gap-1.5 text-[10px]">
                <ToolTraceLabel label="Tool" value={trace.label} />
                <ToolTraceLabel label="Status" value={t(trace.statusLabel)} />
                {trace.path && (
                  <ToolTraceLabel
                    label="Path"
                    value={trace.path}
                    valueClassName="font-mono text-[9px]"
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ToolTraceLabel({
  label,
  value,
  valueClassName = '',
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <span className="inline-flex max-w-full min-w-0 overflow-hidden rounded border border-hairline bg-surface-card text-muted shadow-sm">
      <span className="shrink-0 border-r border-hairline bg-surface-soft px-1.5 py-0.5 text-muted-soft">
        {label}
      </span>
      <span className={`min-w-0 truncate px-1.5 py-0.5 ${valueClassName}`}>
        {value}
      </span>
    </span>
  );
}

function ThinkingIndicator({
  progressLabel,
  toolTraces,
}: {
  progressLabel: string | null;
  toolTraces: Message[];
}) {
  const { t } = useI18n();
  const statusLabel = progressLabel
    ? t('aiChat.messageList.progressSuffix', { label: progressLabel })
    : t('aiChat.messageList.aiReplying');

  return (
    <div className="max-w-2xl mx-auto flex justify-start animate-message-in">
      <div className="flex min-w-0 max-w-[88%] flex-col items-start sm:max-w-[78%]">
        <div className="max-w-full rounded-xl px-3 py-2 bg-surface-card border border-hairline shadow-sm">
          <div className="flex items-center gap-2 text-[12px] leading-6 text-muted">
            <div className="flex items-center gap-1" aria-hidden="true">
              {[0, 1, 2].map((index) => (
                <div
                  key={index}
                  className="w-1 h-1 rounded-full bg-primary animate-thinking-dot"
                  style={{ animationDelay: `${index * 0.2}s` }}
                />
              ))}
            </div>
            <span>{statusLabel}</span>
          </div>
          {toolTraces.length > 0 && <ToolTraceList messages={toolTraces} />}
        </div>
      </div>
    </div>
  );
}

function BaguaPattern() {
  return (
    <div className="relative w-12 h-12 mb-2">
      <svg
        viewBox="0 0 64 64"
        className="w-full h-full text-primary/20"
      >
        <circle
          cx="32"
          cy="32"
          r="30"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
        />
        <circle
          cx="32"
          cy="32"
          r="20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
        />
        <circle
          cx="32"
          cy="32"
          r="10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
        />
        {[0, 45, 90, 135].map((angle) => (
          <line
            key={angle}
            x1="32"
            y1="2"
            x2="32"
            y2="62"
            stroke="currentColor"
            strokeWidth="1"
            transform={`rotate(${angle} 32 32)`}
          />
        ))}
      </svg>
    </div>
  );
}
