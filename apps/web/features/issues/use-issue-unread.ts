'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { issuesApi } from './api';

// One module-level count keeps the sidebar badge and the issues pages in agreement.
let snapshot: { userId: string; count: number } | null = null;
let generation = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function refreshIssueUnread(userId: string) {
  const current = ++generation;
  return issuesApi
    .unreadCount()
    .then(({ unread_count }) => {
      // A slower response from an earlier account or request must not overwrite a newer count.
      if (current !== generation) return;
      snapshot = { userId, count: unread_count };
      listeners.forEach((listener) => listener());
    })
    .catch(() => {});
}

export function useIssueUnreadCount(userId: string | undefined, poll = false) {
  const value = useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => null,
  );
  useEffect(() => {
    if (!userId || !poll) return;
    const update = () => {
      if (document.visibilityState === 'visible')
        void refreshIssueUnread(userId);
    };
    update();
    const timer = setInterval(update, 60_000);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [userId, poll]);
  return userId && value?.userId === userId ? value.count : 0;
}
