'use client';

import { useEffect, useState } from 'react';
import { Bot, Loader2, ScrollText, User, X } from 'lucide-react';

import {
  admin,
  type AdminChatSessionDetailResponse,
} from '@/lib/admin-api';
import type { MessageDto } from '@fateclaw/contracts/chat';
import { MarkdownContent } from '@/components/chat/markdown-content';
import { useEscapeKey } from '@/lib/use-escape-key';

/** tool_context 解析出的单条卦象/工具产物（前端展示协议子集）。 */
interface SkillContextEntry {
  skill?: string;
  output?: string;
  artifactTitle?: string;
}

/** 容错解析消息的 tool_context（JSON 字符串）为卦象条目数组；解析失败返回空数组。 */
function parseToolContext(raw?: string | null): SkillContextEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SkillContextEntry[]) : [];
  } catch {
    return [];
  }
}

/** 时间戳转本地可读字符串；非法时间原样返回。 */
function formatTime(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime())
    ? ts
    : d.toLocaleString('zh-CN', { hour12: false });
}

/**
 * 管理员会话完整详情弹层。
 *
 * 拉取 GET /api/admin/chat-sessions/:id，像用户一样展示整段对话：用户提问 + AI markdown 断卦，
 * 并把每条消息携带的卦象（tool_context）以「盘面名 + 文本盘面」呈现，
 * 让管理员看到与用户实质一致的内容（含断了什么卦、盘面数据、AI 解读）。
 *
 * @param sessionId 目标会话 id。
 * @param onClose 关闭回调。
 */
export function AdminSessionDetailModal({
  sessionId,
  onClose,
}: {
  sessionId: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<AdminChatSessionDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Esc 关闭弹层，无需鼠标找关闭按钮。
  useEscapeKey(onClose);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    admin
      .chatSessionDetail(sessionId)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '加载会话详情失败');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-3xl flex-col rounded-2xl border border-hairline bg-canvas shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-hairline px-5 py-3.5">
          <div className="min-w-0">
            <h2 className="truncate text-[14px] font-semibold">
              {data?.session.title || '会话详情'}
            </h2>
            {data?.client ? (
              <p className="mt-0.5 truncate text-[12px] text-muted">
                客户：{data.client.name}
                {data.client.gender ? ` · ${data.client.gender}` : ''}
                {data.client.solar_date ? ` · ${data.client.solar_date}` : ''}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="shrink-0 rounded-md p-1 text-muted transition-colors hover:text-ink"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-20 text-[13px] text-muted">
              <Loader2 size={16} className="animate-spin" />
              加载中
            </div>
          ) : error ? (
            <div className="py-20 text-center text-[13px] text-error">
              {error}
            </div>
          ) : !data || data.messages.length === 0 ? (
            <div className="py-20 text-center text-[13px] text-muted">
              该会话暂无消息
            </div>
          ) : (
            <div className="mx-auto max-w-2xl space-y-3">
              {data.messages.map((msg) => (
                <DetailMessageRow
                  key={`${msg.id}-${msg.account_id}`}
                  msg={msg}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** 单条消息渲染：先展示卦象盘面（若有），再展示消息正文。 */
function DetailMessageRow({ msg }: { msg: MessageDto }) {
  const isBot = msg.is_from_me || msg.is_bot_message;
  const artifacts = parseToolContext(msg.tool_context).filter(
    (entry) => entry.output || entry.artifactTitle,
  );

  return (
    <div className={`flex items-end gap-2 ${isBot ? '' : 'flex-row-reverse'}`}>
      <div
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
          isBot ? 'bg-primary/10 text-primary' : 'bg-primary text-on-primary'
        }`}
      >
        {isBot ? <Bot size={14} /> : <User size={14} />}
      </div>
      <div className="min-w-0 max-w-[82%]">
        {!isBot && (
          <p className="mb-0.5 mr-1 text-right text-[11px] text-muted">
            {msg.sender_name || msg.sender}
          </p>
        )}

        {/* 卦象盘面：盘面名 + 文本盘面，置于该条消息正文之上 */}
        {artifacts.map((entry, index) => (
          <div
            key={index}
            className="mb-1.5 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2"
          >
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-primary">
              <ScrollText size={12} />
              {entry.artifactTitle || entry.skill || '盘面'}
            </div>
            {entry.output ? (
              <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-body">
                {entry.output}
              </pre>
            ) : null}
          </div>
        ))}

        <div
          className={`rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed ${
            isBot
              ? 'rounded-bl-md border border-hairline border-l-2 border-l-primary/60 bg-surface-card'
              : 'rounded-br-md bg-primary text-on-primary'
          }`}
        >
          {isBot ? (
            <MarkdownContent content={msg.content} isBot={isBot} />
          ) : (
            <p className="whitespace-pre-wrap break-words">{msg.content}</p>
          )}
        </div>
        <p
          className={`mt-1 px-1 text-[10px] text-muted ${
            isBot ? 'text-left' : 'text-right'
          }`}
        >
          {formatTime(msg.timestamp)}
        </p>
      </div>
    </div>
  );
}
