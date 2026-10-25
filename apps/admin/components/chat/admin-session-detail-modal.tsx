'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';

import {
  admin,
  type AdminChatSessionDetailResponse,
} from '@/lib/admin-api';
import { ToastProvider } from '@/components/ui/toast';
import { AdminConversation } from './admin-conversation';

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
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

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
    <dialog
      ref={dialogRef}
      aria-label={data?.session.title || '会话详情'}
      onClose={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        ) onClose();
      }}
      className="fixed inset-0 m-auto max-h-[88vh] w-[calc(100%-2rem)] max-w-6xl overflow-hidden rounded-2xl border border-hairline bg-canvas p-0 text-ink shadow-xl backdrop:bg-black/40"
    >
      <ToastProvider>
        <div className="flex max-h-[88vh] flex-col">
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

          <div
            data-artifact-viewport
            className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5"
          >
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
              <AdminConversation messages={data.messages} />
            )}
          </div>
        </div>
      </ToastProvider>
    </dialog>
  );
}
