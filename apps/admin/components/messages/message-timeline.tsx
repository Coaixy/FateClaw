'use client';

import { Bot, MessageSquare, User } from 'lucide-react';

import type { AdminMessage } from '@/lib/admin-api';
import { MarkdownContent } from '@/components/chat/markdown-content';

/** 消息气泡内的时间（时:分）。 */
function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 时间线按日分组用的相对日期标签（今天/昨天/N 天前/月日）。 */
function formatDateLabel(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  return d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
}

/** 已删除标记徽章；会话列表与消息时间线共用。 */
export function DeletedBadge() {
  return (
    <span className="inline-flex items-center rounded-full border border-error/30 bg-error/10 px-2 py-0.5 text-[10px] font-medium text-error">
      已删除
    </span>
  );
}

/** 把按时间升序的消息按自然日分组，便于时间线插入日期分隔。 */
function groupByDate(
  msgs: AdminMessage[],
): { label: string; date: string; messages: AdminMessage[] }[] {
  const groups: {
    label: string;
    date: string;
    messages: AdminMessage[];
  }[] = [];
  for (const msg of msgs) {
    const date = msg.timestamp.slice(0, 10);
    const last = groups[groups.length - 1];
    if (last && last.date === date) {
      last.messages.push(msg);
    } else {
      groups.push({
        label: formatDateLabel(msg.timestamp),
        date,
        messages: [msg],
      });
    }
  }
  return groups;
}

/**
 * 对话时间线：按日分组渲染一段会话的消息气泡（Bot 左 / 用户右）。
 *
 * @param messages 该会话的消息列表（升序）。
 * @param searchText 关键词过滤（命中内容/发送者/会话标题）。
 * @param emptyText 无消息或无匹配时的空态文案。
 */
export function MessageTimeline({
  messages,
  searchText,
  emptyText,
}: {
  messages: AdminMessage[];
  searchText: string;
  emptyText: string;
}) {
  const filtered = searchText
    ? messages.filter(
        (m) =>
          m.content.toLowerCase().includes(searchText.toLowerCase()) ||
          m.sender_name?.toLowerCase().includes(searchText.toLowerCase()) ||
          m.session_title?.toLowerCase().includes(searchText.toLowerCase()),
      )
    : messages;

  const sorted = [...filtered].reverse();
  const groups = groupByDate(sorted);

  if (sorted.length === 0) {
    return (
      <div className="text-center py-16">
        <MessageSquare size={24} className="mx-auto mb-2 text-muted" />
        <p className="text-[13px] text-muted">{emptyText}</p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto">
      {groups.map((group) => (
        <div key={group.date}>
          <div className="flex items-center gap-3 my-5">
            <div className="flex-1 h-px bg-hairline" />
            <span className="text-[11px] text-muted shrink-0">
              {group.label}
            </span>
            <div className="flex-1 h-px bg-hairline" />
          </div>

          <div className="space-y-3">
            {group.messages.map((msg) => {
              const isBot = msg.is_from_me || msg.is_bot_message;
              const isDeleted = Boolean(
                msg.deleted_at || msg.session_deleted_at,
              );
              return (
                <div
                  key={`${msg.id}-${msg.account_id}`}
                  className={`flex items-end gap-2 ${isBot ? '' : 'flex-row-reverse'}`}
                >
                  <div
                    className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
                      isBot
                        ? 'bg-primary/10 text-primary'
                        : 'bg-primary text-on-primary'
                    }`}
                  >
                    {isBot ? <Bot size={14} /> : <User size={14} />}
                  </div>

                  <div className="max-w-[80%] group relative">
                    {!isBot && (
                      <p className="text-[11px] text-muted mb-0.5 text-right mr-1">
                        {msg.sender_name || msg.sender}
                      </p>
                    )}
                    {isDeleted ? (
                      <div
                        className={`mb-1 px-1 flex ${
                          isBot ? 'justify-start' : 'justify-end'
                        }`}
                      >
                        <DeletedBadge />
                      </div>
                    ) : null}
                    <div
                      className={`rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed ${
                        isBot
                          ? 'bg-surface-card border border-hairline border-l-2 border-l-primary/60 rounded-bl-md'
                          : 'bg-primary text-on-primary rounded-br-md'
                      }`}
                    >
                      {isBot ? (
                        <MarkdownContent content={msg.content} isBot={isBot} />
                      ) : (
                        <p className="whitespace-pre-wrap break-words">
                          {msg.content}
                        </p>
                      )}
                    </div>
                    <p
                      className={`text-[10px] mt-1 px-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150 ${
                        isBot ? 'text-muted text-left' : 'text-muted text-right'
                      }`}
                    >
                      {formatTime(msg.timestamp)}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
