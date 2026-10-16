'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ModelPoolKey,
  ModelSettingsOverviewDto,
} from '@fateclaw/contracts/model-settings';
import type { ChatSessionDto } from '@fateclaw/contracts/chat';
import { modelSettingsApi } from './api';
import { useI18n } from '@/lib/i18n';

export function useModelSelection(args: {
  userId?: string;
  sessionId?: string;
  session?: ChatSessionDto;
  sending: boolean;
  onSessionChange: (id: string, session: Partial<ChatSessionDto>) => void;
}) {
  const { t } = useI18n();
  const [overview, setOverview] = useState<ModelSettingsOverviewDto | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const version = useRef(0);
  const currentUser = useRef(args.userId);
  currentUser.current = args.userId;
  const currentT = useRef(t);
  currentT.current = t;
  const mutationUser = useRef<string | undefined>(undefined);
  const sending = useRef(args.sending);
  sending.current = args.sending;
  const refresh = useCallback(async () => {
    if (args.userId && mutationUser.current === args.userId) return;
    const current = ++version.current;
    if (!args.userId) {
      setOverview(null);
      setError('');
      setBusy(false);
      return;
    }
    setBusy(true);
    try {
      const data = await modelSettingsApi.overview();
      if (current === version.current && currentUser.current === args.userId) {
        setOverview(data);
        setError('');
      }
    } catch {
      if (current === version.current && currentUser.current === args.userId)
        setError(currentT.current('modelChoice.loadFailed'));
    } finally {
      if (current === version.current) setBusy(false);
    }
  }, [args.userId]);
  useEffect(() => {
    setOverview(null);
    void refresh();
    return () => {
      version.current += 1;
    };
  }, [refresh]);
  useEffect(() => {
    if (!args.userId) return;
    const update = () => {
      if (document.visibilityState === 'visible' && !sending.current)
        void refresh();
    };
    const timer = setInterval(update, 60_000);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [args.userId, refresh]);
  const wasSending = useRef(false);
  useEffect(() => {
    if (wasSending.current && !args.sending) void refresh();
    wasSending.current = args.sending;
  }, [args.sending, refresh]);
  const poolKey =
    args.session?.model_pool_key ??
    (args.sessionId ? 'official' : (overview?.preferred_pool ?? 'official'));
  const change = async (key: ModelPoolKey) => {
    if (
      busy ||
      args.sending ||
      !args.userId ||
      mutationUser.current === args.userId
    )
      return;
    const userId = args.userId;
    mutationUser.current = userId;
    const current = ++version.current;
    setBusy(true);
    setError('');
    try {
      const data = await modelSettingsApi.setPreference(key, args.session?.id);
      if (currentUser.current !== userId) return;
      if (args.session)
        args.onSessionChange(args.session.id, { model_pool_key: key });
      if (current !== version.current) return;
      setOverview(data);
    } catch (cause) {
      if (current === version.current)
        setError(
          cause instanceof Error ? cause.message : t('modelChoice.saveFailed'),
        );
    } finally {
      if (mutationUser.current === userId) mutationUser.current = undefined;
      if (current === version.current) setBusy(false);
    }
  };
  const unavailable =
    poolKey === 'benefit' &&
    (!overview?.benefit?.model ||
      overview.benefit.supply !== 'available' ||
      (overview.benefit.remaining_turns ?? 0) <= 0);
  return {
    overview,
    poolKey,
    busy,
    error,
    refresh,
    change,
    blocked: Boolean(
      args.userId &&
      (busy || !overview || unavailable || (args.sessionId && !args.session)),
    ),
  };
}
