'use client';

import Link from 'next/link';
import { Brain, Crown, Wallet } from 'lucide-react';

import { ArtifactDebug } from '@/components/chat/artifact-debug';
import { ArtifactRenderer } from '@/components/chat/artifact-renderer';
import { AiGeneratedLabel } from '@/components/chat/ai-generated-label';
import { ChatLoadingState } from '@/components/chat/chat-loading-state';
import { CollapsibleMessage } from '@/components/chat/collapsible-message';
import { Message } from '@/features/chat/api';
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

export function AiChatMessageList({
  messages,
  loading,
  sending,
  progressLabel,
  selectedSession,
  switchingSession,
  showCenteredComposer,
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
  composer: React.ReactNode;
  emptyStateTitle?: string;
  emptyStateDescription?: string;
  emptyStateHint?: string;
  emptyStateFrameClassName?: string;
  emptyStateMaxWidthClassName?: string;
}) {
  if (showCenteredComposer) {
    const title = emptyStateTitle ?? '可以直接问，也可以手动排盘';
    const description =
      emptyStateDescription ?? '输入问题直接对话，或从下方进入手动排盘';
    const hint =
      emptyStateHint ??
      (selectedSession
        ? '发送一条消息开始对话 · / 查看指令'
        : '发送即可开始对话 · 也可手动排盘 · / 查看指令');

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
          selectedSession={selectedSession}
        />
      ))}

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

function shouldShowWalletRecovery(content: string) {
  return /余额已欠费|充值后继续使用|余额不足|欠费/.test(content);
}

function AiChatMessageRow({
  message,
  toolTraces,
  animationIndex,
  selectedSession,
}: {
  message: Message;
  toolTraces: Message[];
  animationIndex: number;
  selectedSession: string;
}) {
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
  const { body: displayContent, marker: finalMarker } = isBot
    ? splitFinalTurnMarker(message.content)
    : { body: message.content, marker: null };
  const durationLabel = isBot
    ? formatChatDuration(messageMetadata?.duration_ms)
    : null;
  const costLabels = isBot ? formatChatCostLabels(messageMetadata) : [];
  const toolContext = isBot ? parseToolContext(message.tool_context) : [];
  const hasChart =
    isBot && toolContext.some((entry) => PAIPAN_SKILLS.has(entry.skill));
  const rendersTextBubble = !hasChart || isFinalMessage;
  const showAiGeneratedLabel =
    !isErrorMessage &&
    rendersTextBubble &&
    displayContent.trim().length > 0 &&
    canHostToolTraceFooter(message);
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
          showAiGeneratedLabel={showAiGeneratedLabel}
          finalMarker={finalMarker}
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
            <CollapsibleMessage
              content={displayContent}
              isBot={isBot}
            />
          </div>
          {showWalletRecovery ? (
            <div className="mt-2 flex flex-wrap gap-2">
              <Link
                href="/wallet"
                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-[12px] font-medium text-on-primary shadow-sm transition-colors hover:bg-primary-active"
              >
                <Wallet size={12} />
                去充值
              </Link>
              <Link
                href="/membership"
                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-primary/25 bg-primary/10 px-3 text-[12px] font-medium text-primary shadow-sm transition-colors hover:bg-primary/15"
              >
                <Crown size={12} />
                会员中心
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
          <ToolTraceList messages={toolTraces} />
        )}

        <MessageFooter
          isBot={isBot}
          showAiGeneratedLabel={showAiGeneratedLabel}
          finalMarker={finalMarker}
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
  const displayContent = content.trim() || '正在思考...';

  return (
    <div
      className="max-w-2xl mx-auto flex justify-start animate-message-in"
      style={{ animationDelay: `${Math.min(animationIndex * 30, 120)}ms` }}
    >
      <div className="flex min-w-0 max-w-[82%] flex-col items-start sm:max-w-[62%]">
        <div className="max-w-full overflow-hidden rounded-lg border border-hairline bg-surface-card/80 px-2.5 py-2 shadow-sm">
          <div className="mb-1 flex items-center gap-1.5 text-[10px] font-medium leading-4 text-muted-soft">
            <Brain size={11} strokeWidth={1.8} aria-hidden="true" />
            <span>思考</span>
          </div>
          <div className="thinking-scrollbar max-h-24 overflow-y-auto overscroll-contain pr-1 text-[11px] leading-5 text-muted whitespace-pre-wrap break-words">
            {displayContent}
          </div>
        </div>
      </div>
    </div>
  );
}

function MessageFooter({
  isBot,
  showAiGeneratedLabel,
  finalMarker,
  durationLabel,
  costLabels,
}: {
  isBot: boolean;
  showAiGeneratedLabel: boolean;
  finalMarker: string | null;
  durationLabel: string | null;
  costLabels: string[];
}) {
  if (
    !showAiGeneratedLabel &&
    !finalMarker &&
    !durationLabel &&
    costLabels.length === 0
  ) {
    return null;
  }

  return (
    <div
      className={`mt-1 flex flex-wrap items-center gap-1.5 px-1 text-[10px] tabular-nums ${
        isBot ? 'justify-start text-left' : 'justify-end text-right'
      }`}
    >
      {showAiGeneratedLabel && <AiGeneratedLabel />}
      {finalMarker && (
        <span className="inline-flex items-center rounded-full border border-hairline bg-surface-card px-1.5 py-0.5 font-medium text-muted shadow-sm">
          {finalMarker}
        </span>
      )}
      {durationLabel && (
        <span className="inline-flex items-center rounded-full border border-hairline bg-surface-card px-1.5 py-0.5 font-medium text-muted shadow-sm">
          {durationLabel}
        </span>
      )}
      {costLabels.map((costLabel) => (
        <span
          key={costLabel}
          className="inline-flex items-center rounded-full border border-hairline bg-surface-card px-1.5 py-0.5 font-medium text-muted shadow-sm"
        >
          {costLabel}
        </span>
      ))}
    </div>
  );
}

function ToolTraceList({ messages }: { messages: Message[] }) {
  return (
    <div className="mt-1 flex max-w-full flex-col gap-1">
      {messages.map((message) => {
        const metadata =
          message.metadata &&
          typeof message.metadata === 'object' &&
          !Array.isArray(message.metadata)
            ? message.metadata
            : null;
        const status = metadata?.tool_status as
          | 'running'
          | 'completed'
          | 'failed'
          | undefined;
        const path =
          typeof metadata?.tool_path === 'string'
            ? sanitizeToolPath(metadata.tool_path)
            : undefined;
        const label =
          (metadata?.tool_name as string | undefined) ||
          (metadata?.tool_label as string | undefined) ||
          'tool';
        const statusLabel = status ?? 'unknown';

        return (
          <div key={message.id} className="flex min-w-0">
            <div className="min-w-0 flex flex-wrap items-center gap-1.5 text-[10px]">
              <ToolTraceLabel label="Tool" value={label} />
              <ToolTraceLabel label="Status" value={statusLabel} />
              {path && (
                <ToolTraceLabel
                  label="Path"
                  value={path}
                  valueClassName="font-mono text-[9px]"
                />
              )}
            </div>
          </div>
        );
      })}
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
  const statusLabel = progressLabel ? `${progressLabel}中...` : 'AI 正在回复...';

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
