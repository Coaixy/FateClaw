'use client';

import { useCallback, useMemo } from 'react';
import { MessageSquare } from 'lucide-react';
import type { MessageDto } from '@fateclaw/contracts/chat';
import { filterProgressMessages } from 'fateclaw-web/chat';

import type { AdminMessage } from '@/lib/admin-api';
import { AdminConversation } from '../chat/admin-conversation';

export function DeletedBadge() {
  return (
    <span className="inline-flex items-center rounded-full border border-error/30 bg-error/10 px-2 py-0.5 text-[10px] font-medium text-error">
      已删除
    </span>
  );
}

export function MessageTimeline({
  messages,
  fullMessages,
  searchText,
  emptyText,
}: {
  messages: AdminMessage[];
  fullMessages?: MessageDto[];
  searchText: string;
  emptyText: string;
}) {
  const visibleMessages = useMemo(() => {
    const details = new Map(fullMessages?.map((message) => [message.id, message]));
    const query = searchText.toLowerCase();
    const enriched = messages.map((message) => {
      const detail = details.get(message.id);
      return detail ? { ...message, ...detail } : message;
    });
    return filterProgressMessages(enriched)
      .filter(
        (message) =>
          !query ||
          message.content.toLowerCase().includes(query) ||
          message.sender_name?.toLowerCase().includes(query) ||
          message.session_title?.toLowerCase().includes(query),
      )
      .sort(
        (a, b) =>
          a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id),
      );
  }, [fullMessages, messages, searchText]);
  const contextById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages],
  );
  const renderMessageContext = useCallback(
    (message: MessageDto) => {
      const context = contextById.get(message.id);
      const deleted = context?.deleted_at || context?.session_deleted_at;
      return (
        <div className="mb-1 flex items-center gap-2 text-[10px] text-muted">
          <time dateTime={message.timestamp}>
            {new Date(message.timestamp).toLocaleString('zh-CN', { hour12: false })}
          </time>
          {deleted ? <DeletedBadge /> : null}
        </div>
      );
    },
    [contextById],
  );

  if (visibleMessages.length === 0) {
    return (
      <div className="text-center py-16">
        <MessageSquare size={24} className="mx-auto mb-2 text-muted" />
        <p className="text-[13px] text-muted">{emptyText}</p>
      </div>
    );
  }

  return (
    <AdminConversation
      messages={visibleMessages}
      renderMessageContext={renderMessageContext}
    />
  );
}
