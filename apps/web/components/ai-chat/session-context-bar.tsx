'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Compass, Loader2, RefreshCw, Users } from 'lucide-react';
import type { SessionBoardSummaryDto } from '@fateclaw/contracts/chat';
import { clientProfilesApi } from '@/features/chat/client-profiles-api';
import { useI18n } from '@/lib/i18n';

export function SessionContextBar({
  boards,
  selectedBoardId,
  clientId,
  loading,
  error,
  disabled,
  onSelect,
  onRetry,
}: {
  boards: SessionBoardSummaryDto[];
  selectedBoardId: string;
  clientId?: string | null;
  loading: boolean;
  error: boolean;
  disabled: boolean;
  onSelect: (id: string) => void;
  onRetry: () => void;
}) {
  const { t, formatDate } = useI18n();
  const [client, setClient] = useState<{ id: string; name: string } | null>(
    null,
  );
  useEffect(() => {
    let disposed = false;
    if (!clientId) return;
    void clientProfilesApi
      .get(clientId)
      .then((value) => {
        if (!disposed) setClient({ id: value.id, name: value.name });
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [clientId]);

  if (!boards.length && !clientId && !loading && !error) return null;
  return (
    <div className="mx-auto mb-2 flex w-full max-w-2xl shrink-0 flex-wrap items-center gap-2 border-b border-hairline/60 px-2 pb-2 text-[12px] text-muted">
      {(boards.length > 0 || loading || error) && (
        <label className="flex min-w-0 flex-1 items-center gap-2">
          <Compass
            size={14}
            className="shrink-0 text-primary"
            aria-hidden="true"
          />
          <span className="shrink-0">{t('aiChat.context.currentBoard')}</span>
          {loading && !boards.length ? (
            <Loader2
              size={13}
              className="animate-spin"
              aria-label={t('common.loading')}
            />
          ) : (
            <select
              aria-label={t('aiChat.context.currentBoard')}
              value={selectedBoardId}
              disabled={disabled || boards.length === 0}
              onChange={(event) => onSelect(event.target.value)}
              className="h-9 min-w-0 flex-1 rounded-md border border-hairline bg-surface-raised px-2 text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:opacity-60"
            >
              <option value="">
                {t('aiChat.context.latestBoard')}
                {boards[0] ? ` · ${boards[0].title}` : ''}
              </option>
              {boards.map((board) => (
                <option
                  key={board.source_message_id}
                  value={board.source_message_id}
                >
                  {board.title}
                  {board.created_at
                    ? ` · ${formatDate(board.created_at, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
                    : ''}
                </option>
              ))}
            </select>
          )}
        </label>
      )}
      {error && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex min-h-9 items-center gap-1 rounded-md px-2 text-error hover:bg-error/5"
        >
          <RefreshCw size={12} />
          {t('aiChat.context.retryBoards')}
        </button>
      )}
      {clientId && (
        <Link
          href={`/clients/detail?id=${encodeURIComponent(clientId)}`}
          className="inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-md px-2 hover:bg-surface-soft hover:text-ink"
        >
          <Users size={13} />
          <span className="truncate">
            {client?.id === clientId ? client.name : t('hub.clients')}
          </span>
        </Link>
      )}
    </div>
  );
}
