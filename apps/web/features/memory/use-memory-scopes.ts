'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MemoryScopeDto } from '@fateclaw/contracts/memory';

import { useI18n } from '@/lib/i18n';
import { memoryApi, type MemoryScopesData } from './api';

export function useMemoryScopes() {
  const { t } = useI18n();
  const [data, setData] = useState<MemoryScopesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);

  const refresh = useCallback(async (): Promise<MemoryScopesData | null> => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setLoading(true);
    try {
      const result = await memoryApi.scopes(request.signal);
      if (request.signal.aborted) return null;
      setData((previous) => ({
        ...result,
        scopes: result.scopes.map((scope) => {
          const saved = previous?.scopes.find(
            (candidate) => candidate.id === scope.id,
          );
          return saved && saved.binding_revision > scope.binding_revision
            ? saved
            : scope;
        }),
      }));
      setError('');
      return result;
    } catch (err) {
      if (!request.signal.aborted)
        setError(
          err instanceof Error ? err.message : t('memory.speakers.loadFailed'),
        );
      return null;
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refresh();
    return () => controller.current?.abort();
  }, [refresh]);

  const accept = useCallback((saved: MemoryScopeDto) => {
    setData((previous) =>
      previous
        ? {
            ...previous,
            scopes: previous.scopes.map((scope) =>
              scope.id === saved.id &&
              scope.binding_revision <= saved.binding_revision
                ? saved
                : scope,
            ),
          }
        : previous,
    );
  }, []);

  return {
    scopes: data?.scopes ?? [],
    subjects: data?.subjects ?? [],
    loading,
    error,
    refresh,
    accept,
  };
}
