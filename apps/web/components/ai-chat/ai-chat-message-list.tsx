'use client';

import { Bot, User } from 'lucide-react';

import { ArtifactDebug } from '@/components/chat/artifact-debug';
import { ArtifactRenderer } from '@/components/chat/artifact-renderer';
import { ChatLoadingState } from '@/components/chat/chat-loading-state';
import { CollapsibleMessage } from '@/components/chat/collapsible-message';
import { Message } from '@/features/chat/api';
import {
  PAIPAN_SKILLS,
  formatChatTime,
  isKnowledgeTrajectoryMessage,
  isStreamingAssistantMessage,
} from '@/features/chat/utils/display';
import { parseToolContext } from '@/features/chat/utils/tool-context';
import { splitFinalTurnMarker } from '@/features/chat/utils/markers';

export function AiChatMessageList({
  messages,
  loading,
  sending,
  progressLabel,
  selectedSession,
  showCenteredComposer,
  composer,
}: {
  messages: Message[];
  loading: boolean;
  sending: boolean;
  progressLabel: string | null;
  selectedSession: string;
  showCenteredComposer: boolean;
  composer: React.ReactNode;
}) {
  if (showCenteredComposer) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-3">
        <div className="w-full max-w-xl flex flex-col items-center gap-3.5">
          <BaguaPattern />
          <div className="text-center space-y-1">
            <h1 className="text-[16px] sm:text-[18px] lg:text-[20px] font-semibold tracking-tight text-ink">
              可以直接问，也可以手动排盘
            </h1>
            <p className="text-[10px] sm:text-[11px] text-muted">
              输入问题直接对话，或从下方进入手动排盘
            </p>
          </div>
          <div className="w-full">{composer}</div>
          <p className="text-[9px] text-muted/50 select-none">
            {selectedSession
              ? '发送一条消息开始对话 · / 查看指令'
              : '发送即可开始对话 · 也可手动排盘 · / 查看指令'}
          </p>
        </div>
      </div>
    );
  }

  if (loading && messages.length === 0 && !sending) {
    return <ChatLoadingState count={3} />;
  }

  const showThinkingIndicator =
    sending && !messages.some(isStreamingAssistantMessage);

  return (
    <div className="px-1.5 lg:px-3 space-y-2.5 lg:space-y-3">
      {messages.map((message, index) => (
        <AiChatMessageRow
          key={message.id}
          message={message}
          animationIndex={index}
          selectedSession={selectedSession}
        />
      ))}

      {showThinkingIndicator && (
        <div className="max-w-2xl mx-auto">
          <ThinkingIndicator progressLabel={progressLabel} />
        </div>
      )}
    </div>
  );
}

function AiChatMessageRow({
  message,
  animationIndex,
  selectedSession,
}: {
  message: Message;
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
  const isFinalMessage = messageMetadata?.kind === 'final';
  const { body: displayContent, marker: finalMarker } = isBot
    ? splitFinalTurnMarker(message.content)
    : { body: message.content, marker: null };
  const toolContext = isBot ? parseToolContext(message.tool_context) : [];
  const hasChart =
    isBot && toolContext.some((entry) => PAIPAN_SKILLS.has(entry.skill));

  // 知识检索轨迹：紧凑时间线样式
  if (isBot && isKnowledgeTrajectoryMessage(message)) {
    const stage = messageMetadata?.stage as string | undefined;
    const isSectionRead = stage === 'knowledge_section';
    return (
      <div
        className="max-w-2xl mx-auto flex items-center gap-2 pl-9 animate-message-in"
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
          className={`text-[10px] ${
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

  if (hasChart && !isFinalMessage) {
    return (
      <div
        className="w-full max-w-6xl mx-auto animate-message-in"
        style={{ animationDelay: `${Math.min(animationIndex * 50, 200)}ms` }}
      >
        <ArtifactRenderer entries={toolContext} />
        <ArtifactDebug entries={toolContext} />
      </div>
    );
  }

  return (
    <div
      className={`max-w-2xl mx-auto flex items-end gap-2 animate-message-in ${
        isBot ? '' : 'flex-row-reverse'
      }`}
      style={{ animationDelay: `${Math.min(animationIndex * 50, 200)}ms` }}
    >
      <div
        className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 transition-all duration-200 ${
          isBot
            ? 'bg-primary/15 text-primary'
            : 'bg-surface-dark text-on-dark'
        }`}
      >
        {isBot ? <Bot size={13} /> : <User size={13} />}
      </div>

      <div
        className={`flex-1 min-w-0 flex flex-col ${isBot ? 'items-start' : 'items-end'}`}
      >
        <div className="max-w-[88%] sm:max-w-[78%] group relative">
          <div
            className={`rounded-xl px-3 py-2 text-[12px] leading-6 transition-shadow duration-200 ${
              isBot
                ? 'bg-surface-card border border-hairline rounded-bl-sm shadow-sm hover:shadow-md'
                : 'bg-surface-dark text-on-dark rounded-br-sm shadow-sm'
            }`}
          >
            <CollapsibleMessage
              content={displayContent}
              isBot={isBot}
            />
          </div>

          {finalMarker && (
            <div className="mt-1 px-1">
              <span className="inline-flex items-center rounded-full border border-hairline bg-surface-card px-1.5 py-0.5 text-[9px] font-medium tabular-nums text-muted shadow-sm">
                {finalMarker}
              </span>
            </div>
          )}

          <p
            className={`text-[9px] mt-0.5 px-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200 tabular-nums ${
              isBot
                ? 'text-muted text-left'
                : 'text-muted text-right'
            }`}
          >
            {formatChatTime(message.timestamp)}
          </p>
        </div>

        {isBot && !isFinalMessage && toolContext.length > 0 && (
          <div className="w-full max-w-full sm:max-w-[90%] mt-1">
            <ArtifactRenderer entries={toolContext} />
            <ArtifactDebug entries={toolContext} />
          </div>
        )}

      </div>
    </div>
  );
}

function ThinkingIndicator({
  progressLabel,
}: {
  progressLabel: string | null;
}) {
  return (
    <div className="flex items-end gap-2 animate-message-in">
      <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 bg-primary/15 text-primary">
        <Bot size={13} />
      </div>
      <div className="rounded-xl px-3 py-2 bg-surface-card border border-hairline rounded-bl-sm shadow-sm">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            {[0, 1, 2].map((index) => (
              <div
                key={index}
                className="w-1 h-1 rounded-full bg-primary animate-thinking-dot"
                style={{ animationDelay: `${index * 0.2}s` }}
              />
            ))}
          </div>
          {progressLabel && (
            <span className="text-[10px] text-muted">
              {progressLabel}中...
            </span>
          )}
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
      <div className="absolute inset-0 flex items-center justify-center">
        <Bot
          size={16}
          strokeWidth={1.5}
          className="text-primary/60"
        />
      </div>
    </div>
  );
}
