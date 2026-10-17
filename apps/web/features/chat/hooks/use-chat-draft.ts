'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import type { SetStateAction } from 'react';

export interface ChatDraftScope {
  userId?: string | null;
  sessionId?: string | null;
}

interface ResolvedChatDraftScope {
  readonly userId: string | null;
  readonly sessionId: string | null;
}

export interface ChatDraftSubmission {
  readonly input: string;
  readonly scope: ResolvedChatDraftScope;
}

export type ChatDraftStorage = Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem'
>;

interface CachedDraft {
  value: string;
  dirty: boolean;
}

function resolveScope(scope: ChatDraftScope): ResolvedChatDraftScope {
  return {
    userId: scope.userId || null,
    sessionId: scope.sessionId || null,
  };
}

function getDraftKey(scope: ChatDraftScope): string {
  const resolved = resolveScope(scope);
  return `fateclaw:ai-chat:draft:${JSON.stringify([
    resolved.userId,
    resolved.sessionId,
  ])}`;
}

function mergeDrafts(earlier: string, later: string): string {
  if (!earlier) return later;
  if (!later) return earlier;
  return `${earlier}\n\n${later}`;
}

export function createChatDraftStore(
  getStorage: () => ChatDraftStorage | null,
) {
  const drafts = new Map<string, CachedDraft>();
  const listeners = new Set<() => void>();
  const submissions = new WeakMap<
    ChatDraftSubmission,
    ResolvedChatDraftScope
  >();

  const notify = () => listeners.forEach((listener) => listener());

  const readStorage = (key: string): string | undefined => {
    try {
      const storage = getStorage();
      return storage ? (storage.getItem(key) ?? '') : undefined;
    } catch {
      return undefined;
    }
  };

  const persist = (key: string, value: string): boolean => {
    try {
      const storage = getStorage();
      if (!storage) return false;
      if (value) {
        storage.setItem(key, value);
      } else {
        storage.removeItem(key);
      }
      return true;
    } catch {
      return false;
    }
  };

  const getDraft = (scope: ChatDraftScope): string => {
    const key = getDraftKey(scope);
    const cached = drafts.get(key);
    if (cached) return cached.value;
    const value = readStorage(key) ?? '';
    drafts.set(key, { value, dirty: false });
    return value;
  };

  const setDraft = (scope: ChatDraftScope, update: SetStateAction<string>) => {
    const previous = getDraft(scope);
    const value = typeof update === 'function' ? update(previous) : update;
    const key = getDraftKey(scope);
    drafts.set(key, { value, dirty: !persist(key, value) });
    if (value !== previous) notify();
  };

  const refresh = (scope: ChatDraftScope) => {
    const key = getDraftKey(scope);
    // A failed storage write must not erase text that is still editable in memory.
    if (drafts.get(key)?.dirty) return;
    const value = readStorage(key);
    if (value === undefined) return;
    const previous = drafts.get(key)?.value;
    drafts.set(key, { value, dirty: false });
    if (previous !== value) notify();
  };

  return {
    getDraft,
    setDraft,
    refresh,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    takeDraft(scope: ChatDraftScope): ChatDraftSubmission {
      const submission: ChatDraftSubmission = {
        input: getDraft(scope),
        scope: resolveScope(scope),
      };
      submissions.set(submission, submission.scope);
      setDraft(scope, '');
      return submission;
    },
    restoreDraft(submission: ChatDraftSubmission) {
      const scope = submissions.get(submission);
      if (!scope) return;
      submissions.delete(submission);
      refresh(scope);
      setDraft(scope, (current) => mergeDrafts(submission.input, current));
    },
    adoptDraft(
      scope: ChatDraftScope,
      createdSessionId: string,
      submission?: ChatDraftSubmission,
    ) {
      const currentScope = resolveScope(scope);
      const sourceScope = submission
        ? submissions.get(submission)
        : currentScope;
      if (
        !createdSessionId ||
        !sourceScope ||
        sourceScope.sessionId ||
        sourceScope.userId !== currentScope.userId
      ) {
        return;
      }

      const targetScope = {
        userId: sourceScope.userId,
        sessionId: createdSessionId,
      };
      refresh(sourceScope);
      refresh(targetScope);
      const remainingDraft = getDraft(sourceScope);
      setDraft(targetScope, (current) => mergeDrafts(remainingDraft, current));
      setDraft(sourceScope, '');
      if (submission) submissions.set(submission, targetScope);
    },
  };
}

function getSessionStorage(): ChatDraftStorage | null {
  return typeof window === 'undefined' ? null : window.sessionStorage;
}

function getServerDraft(): string {
  return '';
}

export function useChatDraft({ userId, sessionId }: ChatDraftScope) {
  const [store] = useState(() => createChatDraftStore(getSessionStorage));
  const scope = useMemo(
    () => resolveScope({ userId, sessionId }),
    [userId, sessionId],
  );
  const getSnapshot = useCallback(() => store.getDraft(scope), [store, scope]);
  const input = useSyncExternalStore(
    store.subscribe,
    getSnapshot,
    getServerDraft,
  );

  useEffect(() => {
    store.refresh(scope);
  }, [store, scope]);

  const setInput = useCallback(
    (update: SetStateAction<string>) => store.setDraft(scope, update),
    [store, scope],
  );
  const takeDraft = useCallback(() => store.takeDraft(scope), [store, scope]);
  const restoreDraft = useCallback(
    (submission: ChatDraftSubmission) => store.restoreDraft(submission),
    [store],
  );
  const adoptDraft = useCallback(
    (createdSessionId: string, submission?: ChatDraftSubmission) =>
      store.adoptDraft(scope, createdSessionId, submission),
    [store, scope],
  );

  return { input, setInput, takeDraft, restoreDraft, adoptDraft };
}
