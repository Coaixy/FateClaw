'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import type { AnnouncementDto, AnnouncementPollDto } from '@fateclaw/contracts';
import { useAuth } from '@/features/auth/hooks/use-auth';
import { announcementsApi } from './api';

interface AnnouncementState {
  viewer: string;
  items: AnnouncementDto[];
  loading: boolean;
  error: string;
}

export function useAnnouncements(enabled = true) {
  const { user, loading: authLoading } = useAuth();
  const viewer = user?.id ?? '';
  const pathname = usePathname();
  const [state, setState] = useState<AnnouncementState | null>(null);
  const controller = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled || authLoading) return;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setState((previous) => ({
      viewer,
      items: previous?.viewer === viewer ? previous.items : [],
      loading: true,
      error: '',
    }));
    try {
      const result = await announcementsApi.list(request.signal);
      if (!request.signal.aborted) {
        setState({ viewer, items: result.items, loading: false, error: '' });
      }
    } catch (error) {
      if (!request.signal.aborted) {
        setState((previous) => ({
          viewer,
          items: previous?.viewer === viewer ? previous.items : [],
          loading: false,
          error:
            error instanceof Error ? error.message : '公告加载失败，请重试',
        }));
      }
    }
  }, [enabled, authLoading, viewer]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    void refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      controller.current?.abort();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh, pathname]);

  const updatePoll = useCallback(
    (id: string, poll: AnnouncementPollDto) => {
      // A list request started before the vote must not overwrite its confirmed result.
      controller.current?.abort();
      setState((previous) =>
        previous?.viewer === viewer
          ? {
              ...previous,
              loading: false,
              items: previous.items.map((item) =>
                item.id === id ? { ...item, poll } : item,
              ),
            }
          : previous,
      );
    },
    [viewer],
  );

  const current = state?.viewer === viewer ? state : null;
  return {
    items: current?.items ?? [],
    loading: authLoading || !current || current.loading,
    error: current?.error ?? '',
    refresh,
    updatePoll,
    viewer,
  };
}
