'use client';

import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  MessageCircle,
  Sparkles,
  User,
} from 'lucide-react';

import { ArtifactRenderer } from '@/components/chat/artifact-renderer';
import { ChatDateDivider } from '@/components/chat/chat-date-divider';
import { ChatLoadingState } from '@/components/chat/chat-loading-state';
import { CollapsibleMessage } from '@/components/chat/collapsible-message';
import { Message } from '@/features/chat/api';
import { MessageGroup, formatChatTime } from '@/features/chat/utils/display';
import { parseToolContext } from '@/features/chat/utils/tool-context';
import { splitFinalTurnMarker } from '@/features/chat/utils/markers';

export function ChatHistoryMessageList({
  groups,
  allMessages,
  loading,
  selectedAccountName,
  page,
  totalPages,
  hasMore,
  pageSize,
  loadingMore,
  onPageChange,
}: {
  groups: MessageGroup[];
  allMessages: Message[];
  loading: boolean;
  selectedAccountName?: string;
  page: number;
  totalPages: number;
  hasMore: boolean;
  pageSize: number;
  loadingMore: boolean;
  onPageChange: (page: number) => void;
}) {
  if (loading) {
    return <ChatLoadingState count={4} />;
  }

  if (allMessages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-4">
        <div className="relative w-16 h-16 mb-4">
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
            <path
              d="M32 18 L44 28 L44 40 L36 40 L32 46 L28 40 L20 40 L20 28 Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
            />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center">
            <MessageCircle
              size={18}
              strokeWidth={1.5}
              className="text-primary/60"
            />
          </div>
        </div>
        <p className="text-[14px] font-medium mb-1 text-ink">
          开始对话
        </p>
        <p className="text-[12px] text-muted text-center max-w-[260px]">
          {selectedAccountName
            ? `向「${selectedAccountName}」发送消息，也可以直接在微信中对话`
            : '选择一个微信账号查看消息'}
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="max-w-2xl mx-auto px-3">
        {groups.map((group, groupIndex) => (
          <div key={group.date}>
            <ChatDateDivider label={group.label} />
            <div className="space-y-4">
              {group.messages.map((message, messageIndex) => (
                <ChatHistoryMessageRow
                  key={`${message.id}-${message.account_id}`}
                  message={message}
                  animationIndex={groupIndex * 5 + messageIndex}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {allMessages.length > pageSize && (
        <div className="shrink-0 flex items-center justify-center gap-2 py-2 border-t border-hairline/40">
          <button
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages && !hasMore}
            className="flex items-center gap-1.5 px-3 h-8 rounded-full text-[11px] text-muted hover:text-ink hover:bg-surface-card transition-all duration-200 cursor-pointer disabled:opacity-20 disabled:cursor-not-allowed"
          >
            <ChevronLeft size={14} />
            更早
          </button>

          <div className="flex items-center gap-1 px-3 py-1 rounded-full bg-surface-card/60 border border-hairline/40">
            <span className="text-[11px] text-ink tabular-nums font-medium">
              {page}
            </span>
            <span className="text-[11px] text-muted">/</span>
            <span className="text-[11px] text-muted tabular-nums">
              {totalPages}
              {hasMore && '+'}
            </span>
          </div>

          <button
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
            className="flex items-center gap-1.5 px-3 h-8 rounded-full text-[11px] text-muted hover:text-ink hover:bg-surface-card transition-all duration-200 cursor-pointer disabled:opacity-20 disabled:cursor-not-allowed"
          >
            更新
            <ChevronRight size={14} />
          </button>

          {loadingMore && (
            <Loader2
              size={14}
              className="animate-spin text-primary ml-1"
            />
          )}
        </div>
      )}
    </>
  );
}

function ChatHistoryMessageRow({
  message,
  animationIndex,
}: {
  message: Message;
  animationIndex: number;
}) {
  const isBot = !!message.is_bot_message;
  const isOptimistic = message.id.startsWith('optimistic-');
  const { body: displayContent, marker: finalMarker } = isBot
    ? splitFinalTurnMarker(message.content)
    : { body: message.content, marker: null };
  const toolContext = isBot ? parseToolContext(message.tool_context) : [];

  return (
    <div
      className={`flex items-end gap-2.5 animate-message-in ${isBot ? '' : 'flex-row-reverse'} ${
        isOptimistic ? 'opacity-60' : ''
      }`}
      style={{ animationDelay: `${Math.min(animationIndex * 30, 150)}ms` }}
    >
      <div
        className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-transform duration-200 hover:scale-105 ${
          isBot
            ? 'bg-primary/15 text-primary'
            : 'bg-primary text-on-primary'
        }`}
      >
        {isBot ? <Sparkles size={14} /> : <User size={14} />}
      </div>

      <div
        className={`flex-1 min-w-0 flex flex-col ${isBot ? 'items-start' : 'items-end'}`}
      >
        <div className="max-w-[85%] sm:max-w-[80%] group relative">
          {!isBot && message.sender_name && (
            <p className="text-[10px] text-muted mb-1 text-right mr-1.5 font-medium">
              {message.sender_name}
            </p>
          )}

          <div
            className={`rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed transition-shadow duration-200 ${
              isBot
                ? 'bg-surface-card border border-hairline rounded-bl-sm shadow-sm hover:shadow-md'
                : 'bg-primary text-on-primary rounded-br-sm shadow-sm'
            }`}
          >
            <CollapsibleMessage
              content={displayContent}
              isBot={isBot}
              collapsedOverlayClassName={`absolute inset-x-0 bottom-0 h-8 pointer-events-none ${
                isBot
                  ? 'bg-[linear-gradient(transparent,var(--color-surface-card))]'
                  : 'bg-[linear-gradient(transparent,var(--color-primary))]'
              }`}
              toggleClassName={`flex items-center gap-0.5 mt-1.5 text-[10px] hover:underline cursor-pointer ${
                isBot ? 'text-primary' : 'text-on-primary/70'
              }`}
            />
          </div>

          {finalMarker && (
            <div className="mt-1.5 px-1.5">
              <span className="inline-flex items-center rounded-full border border-hairline bg-surface-card px-2 py-1 text-[10px] font-medium tabular-nums text-muted shadow-sm">
                {finalMarker}
              </span>
            </div>
          )}

          <p
            className={`text-[10px] mt-1 px-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200 tabular-nums ${
              isBot
                ? 'text-muted text-left'
                : 'text-muted text-right'
            }`}
          >
            {formatChatTime(message.timestamp)}
          </p>
        </div>

        {isBot && toolContext.length > 0 && (
          <div className="w-full max-w-full sm:max-w-[90%] mt-1">
            <ArtifactRenderer entries={toolContext} />
          </div>
        )}
      </div>
    </div>
  );
}
