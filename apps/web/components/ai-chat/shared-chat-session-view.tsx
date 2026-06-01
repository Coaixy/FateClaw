'use client';

import { Loader2, MessageCircle, Share2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

import { AiChatMessageList } from '@/components/ai-chat/ai-chat-message-list';
import { AppShell } from '@/components/app-shell';
import {
  chatSessionsApi,
  type SharedChatSession,
} from '@/features/chat/api';
import { filterProgressMessages } from '@/features/chat/utils/display';

export function SharedChatSessionView() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token') || '';
  const [session, setSession] = useState<SharedChatSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');

    if (!token.trim()) {
      setSession(null);
      setError('分享链接缺少 token');
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    void chatSessionsApi
      .shared(token)
      .then((result) => {
        if (cancelled) return;
        setSession(result);
      })
      .catch((err) => {
        if (cancelled) return;
        setSession(null);
        setError(err instanceof Error ? err.message : '分享链接加载失败');
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <AppShell wide noPadding requireAuth={false}>
      <div className="flex h-[calc(100dvh-3.5rem)] flex-col pt-2 lg:h-[calc(100dvh-4rem)] lg:pt-0">
        <div className="mx-auto flex w-full max-w-2xl shrink-0 items-center justify-between gap-3 px-2.5 py-2 sm:px-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-primary">
              <Share2 size={12} />
              分享对话
            </div>
            <h1 className="mt-0.5 truncate text-[15px] font-semibold text-ink">
              {session?.title || 'AI Chat 对话'}
            </h1>
          </div>
          {session ? (
            <span className="shrink-0 rounded-md border border-hairline bg-surface-card px-2 py-1 text-[10px] text-muted">
              {new Date(session.updated_at).toLocaleDateString('zh-CN')}
            </span>
          ) : null}
        </div>

        <div className="relative flex-1 overflow-y-auto overscroll-contain py-1.5 lg:py-3">
          {loading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 size={18} className="animate-spin text-muted" />
            </div>
          ) : error ? (
            <div className="flex h-full items-center justify-center px-4">
              <div className="max-w-sm rounded-lg border border-hairline bg-surface-card px-5 py-4 text-center shadow-sm">
                <MessageCircle size={22} className="mx-auto mb-2 text-muted" />
                <p className="text-[13px] font-medium text-ink">
                  无法查看这条分享
                </p>
                <p className="mt-1 text-[11px] text-muted">{error}</p>
              </div>
            </div>
          ) : session ? (
            <AiChatMessageList
              messages={filterProgressMessages(session.messages)}
              loading={false}
              sending={false}
              progressLabel={null}
              selectedSession={session.id}
              switchingSession={false}
              showCenteredComposer={session.messages.length === 0}
              composer={
                <p className="rounded-lg border border-hairline bg-surface-card px-4 py-3 text-center text-[12px] text-muted">
                  这条分享暂无可展示消息
                </p>
              }
            />
          ) : null}
        </div>
      </div>
    </AppShell>
  );
}
