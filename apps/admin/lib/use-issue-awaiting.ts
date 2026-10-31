'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { adminIssues } from './admin-issues-api';

// The sidebar lives in the persistent layout, so moderation actions refresh this shared count directly.
let count = 0;
let generation = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function refreshIssueAwaiting() {
  const current = ++generation;
  return adminIssues
    .summary()
    .then(({ awaiting_reply_count }) => {
      if (current !== generation) return;
      count = awaiting_reply_count;
      listeners.forEach((listener) => listener());
    })
    .catch(() => {});
}

export function useIssueAwaitingCount(enabled: boolean, pathname: string) {
  const value = useSyncExternalStore(
    subscribe,
    () => count,
    () => 0,
  );
  useEffect(() => {
    if (!enabled) return;
    const update = () => {
      if (document.visibilityState === 'visible') void refreshIssueAwaiting();
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
  }, [enabled, pathname]);
  return enabled ? value : 0;
}
