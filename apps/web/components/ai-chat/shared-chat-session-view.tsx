'use client';

import Link from 'next/link';
import { Loader2, MessageCircle, Share2 } from 'lucide-react';
import { useEffect, useReducer } from 'react';
import { useSearchParams } from 'next/navigation';

import { AiChatMessageList } from '@/components/ai-chat/ai-chat-message-list';
import { AppShell } from '@/components/app-shell';
import {
  chatSessionsApi,
  type SharedChatSession,
} from '@/features/chat/api';
import { filterProgressMessages } from '@/features/chat/utils/display';

/** 分享对话页的加载状态：会话数据、加载中、错误三者属同一份请求生命周期。 */
interface SharedSessionState {
  session: SharedChatSession | null;
  loading: boolean;
  error: string;
}

/** 请求生命周期动作；每个动作都返回完整的下一状态快照，避免一次 effect 内多次 setState。 */
type SharedSessionAction =
  | { type: 'start' }
  | { type: 'missing-token' }
  | { type: 'success'; session: SharedChatSession }
  | { type: 'error'; message: string };

function sharedSessionReducer(
  state: SharedSessionState,
  action: SharedSessionAction,
): SharedSessionState {
  switch (action.type) {
    case 'start':
      // 开始拉取：进入加载态并清空旧错误，沿用既有会话（界面此时显示 spinner）。
      return { ...state, loading: true, error: '' };
    case 'missing-token':
      return { session: null, loading: false, error: '分享链接缺少 token' };
    case 'success':
      return { session: action.session, loading: false, error: '' };
    case 'error':
      return { session: null, loading: false, error: action.message };
  }
}

const initialSharedSessionState: SharedSessionState = {
  session: null,
  loading: true,
  error: '',
};

export function SharedChatSessionView() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token') || '';
  const [state, dispatch] = useReducer(
    sharedSessionReducer,
    initialSharedSessionState,
  );
  const { session, loading, error } = state;

  useEffect(() => {
    let cancelled = false;

    if (!token.trim()) {
      dispatch({ type: 'missing-token' });
      return () => {
        cancelled = true;
      };
    }

    dispatch({ type: 'start' });
    void chatSessionsApi
      .shared(token)
      .then((result) => {
        if (cancelled) return;
        dispatch({ type: 'success', session: result });
      })
      .catch((err) => {
        if (cancelled) return;
        dispatch({
          type: 'error',
          message: err instanceof Error ? err.message : '分享链接加载失败',
        });
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <AppShell wide noPadding requireAuth={false}>
      <div className="flex min-h-0 flex-1 flex-col pt-2 lg:pt-0">
        <div className="mx-auto flex w-full max-w-3xl shrink-0 items-center justify-between gap-3 px-2.5 py-2 sm:px-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-primary">
              <Share2 size={12} />
              分享对话
            </div>
            {/* 15px 小标题覆盖全局 h1 衬线规则：小字号衬线屏显发虚。 */}
            <h1 className="mt-0.5 truncate font-sans text-[15px] font-semibold text-ink">
              {session?.title || 'AI Chat 对话'}
            </h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {session ? (
              <span className="hidden rounded-md border border-hairline bg-surface-card px-2 py-1 text-[10px] text-muted sm:inline-flex">
                {new Date(session.updated_at).toLocaleDateString('zh-CN')}
              </span>
            ) : null}
            <Link
              href="/ai-chat"
              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-[12px] font-medium text-on-primary transition-colors hover:bg-primary-active"
            >
              <MessageCircle size={12} />
              新建对话
            </Link>
          </div>
        </div>

        <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain py-3 lg:py-5">
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
