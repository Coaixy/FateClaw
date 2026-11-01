'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, MessageCircle, RefreshCw } from 'lucide-react';
import type { MemorySessionSettingsDto } from '@fateclaw/contracts/memory';

import { Button } from '@/components/ui/button';
import { memoryApi } from '@/features/memory/api';
import { ApiError } from '@/lib/http/client';
import { useI18n } from '@/lib/i18n';

export function MemorySessionLearningPanel({
  disabled,
  globalLearningEnabled,
  refreshKey,
}: {
  disabled: boolean;
  globalLearningEnabled: boolean | undefined;
  refreshKey: number;
}) {
  const { t, formatNumber } = useI18n();
  const [sessions, setSessions] = useState<MemorySessionSettingsDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [pending, setPending] = useState('');
  const read = useRef<AbortController | null>(null);
  const mutation = useRef<AbortController | null>(null);
  const alive = useRef(true);

  const load = useCallback(
    async (next?: string) => {
      read.current?.abort();
      const controller = new AbortController();
      read.current = controller;
      setLoading(true);
      setError('');
      try {
        const result = await memoryApi.sessions(
          { cursor: next, limit: 30 },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setSessions((previous) => {
          const updated = result.sessions.map((session) => {
            const current = previous.find((entry) => entry.id === session.id);
            return current && current.revision > session.revision
              ? current
              : session;
          });
          return next
            ? [
                ...previous,
                ...updated.filter(
                  (session) =>
                    !previous.some((entry) => entry.id === session.id),
                ),
              ]
            : updated;
        });
        setCursor(result.next_cursor);
      } catch (err) {
        if (!controller.signal.aborted)
          setError(err instanceof Error ? err.message : t('memory.loadFailed'));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [t],
  );

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      read.current?.abort();
      mutation.current?.abort();
    };
  }, []);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const toggle = async (session: MemorySessionSettingsDto) => {
    if (disabled || mutation.current) return;
    const controller = new AbortController();
    mutation.current = controller;
    setPending(session.id);
    setActionError('');
    try {
      const saved = await memoryApi.updateSessionSettings(
        session.id,
        {
          learning_enabled: !session.learning_enabled,
          revision: session.revision,
        },
        controller.signal,
      );
      if (!controller.signal.aborted)
        setSessions((previous) =>
          previous.map((entry) => (entry.id === saved.id ? saved : entry)),
        );
    } catch (err) {
      if (controller.signal.aborted) return;
      setActionError(
        err instanceof ApiError && err.status === 409
          ? t('memory.sessions.conflict')
          : err instanceof Error
            ? err.message
            : t('memory.actionFailed'),
      );
      if (err instanceof ApiError && err.status === 409) void load();
    } finally {
      mutation.current = null;
      if (alive.current) setPending('');
    }
  };

  return (
    <details className="rounded-2xl border border-hairline bg-surface-card/50">
      <summary className="cursor-pointer px-4 py-4 text-[13px] font-medium sm:px-5">
        <MessageCircle size={14} className="mr-2 inline text-primary" />
        {t('memory.sessions.title')}
        <span className="ml-2 text-[11px] font-normal text-muted">
          {loading && !sessions.length
            ? t('memory.loading')
            : formatNumber(sessions.length)}
        </span>
      </summary>
      <div className="space-y-3 border-t border-hairline/60 px-4 pb-4 pt-3 sm:px-5">
        <div className="flex items-start justify-between gap-3">
          <p className="min-w-0 flex-1 text-[11px] leading-5 text-muted">
            {t('memory.sessions.description')}
          </p>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            loading={loading}
            disabled={disabled || Boolean(pending)}
            icon={<RefreshCw size={12} />}
            className="shrink-0 whitespace-nowrap"
            onClick={() => void load()}
          >
            {t('memory.refresh')}
          </Button>
        </div>
        {globalLearningEnabled === false && (
          <p className="text-[11px] leading-5 text-muted">
            {t('memory.sessions.globalDisabled')}
          </p>
        )}
        {(error || actionError) && (
          <p role="alert" className="text-[12px] text-error">
            {actionError || error}
          </p>
        )}
        {!loading && !error && sessions.length === 0 && (
          <p className="py-3 text-[12px] text-muted">
            {t('memory.noConversations')}
          </p>
        )}
        <ul className="max-h-72 divide-y divide-hairline/60 overflow-y-auto">
          {sessions.map((session) => (
            <li
              key={session.id}
              className="flex items-center justify-between gap-4 py-3"
            >
              <Link
                href={`/ai-chat?sid=${encodeURIComponent(session.id)}`}
                className="min-w-0 truncate text-[12px] text-ink"
                title={session.title}
              >
                {session.title}
              </Link>
              <button
                type="button"
                role="switch"
                aria-label={t('memory.sessions.switch', {
                  title: session.title,
                })}
                aria-checked={session.learning_enabled}
                disabled={disabled || Boolean(pending) || loading}
                onClick={() => void toggle(session)}
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 disabled:opacity-40"
              >
                <span
                  className={`relative inline-flex h-6 w-11 items-center rounded-full border transition-colors ${session.learning_enabled ? 'border-primary bg-primary' : 'border-hairline bg-muted/20'}`}
                >
                  {pending === session.id ? (
                    <Loader2
                      size={13}
                      className={`mx-auto animate-spin ${session.learning_enabled ? 'text-on-primary' : 'text-primary'}`}
                    />
                  ) : (
                    <span
                      className={`size-4 rounded-full bg-canvas shadow-sm transition-transform ${session.learning_enabled ? 'translate-x-5' : 'translate-x-1'}`}
                    />
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {cursor && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            loading={loading}
            disabled={disabled || Boolean(pending)}
            onClick={() => void load(cursor)}
          >
            {t('memory.loadMore')}
          </Button>
        )}
      </div>
    </details>
  );
}
