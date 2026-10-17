'use client';

import { useCallback, useEffect, useState } from 'react';
import type { SessionBoardSummaryDto } from '@fateclaw/contracts/chat';
import { chatSessionsApi } from '../api';

export function useSessionBoards(options: {
  userId?: string;
  sessionId: string;
  revision: string;
}) {
  const { userId, sessionId, revision } = options;
  const scope = JSON.stringify([userId, sessionId]);
  const storageKey = `fateclaw:ai-chat:board:${scope}`;
  const [snapshot, setSnapshot] = useState<{
    scope: string;
    boards: SessionBoardSummaryDto[];
    selected: string;
    loading: boolean;
    error: boolean;
  }>({ scope: '', boards: [], selected: '', loading: false, error: false });
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let disposed = false;
    if (!userId || !sessionId) return;
    setSnapshot((current) => ({
      scope,
      boards: current.scope === scope ? current.boards : [],
      selected: current.scope === scope ? current.selected : '',
      loading: true,
      error: false,
    }));
    void chatSessionsApi
      .boards(sessionId)
      .then(({ boards }) => {
        if (disposed) return;
        let saved = '';
        try {
          saved = sessionStorage.getItem(storageKey) ?? '';
        } catch {
          /* Storage is optional. */
        }
        setSnapshot((current) => ({
          scope,
          boards,
          selected: boards.some((board) => board.source_message_id === saved)
            ? saved
            : current.scope === scope &&
                boards.some(
                  (board) => board.source_message_id === current.selected,
                )
              ? current.selected
              : '',
          loading: false,
          error: false,
        }));
      })
      .catch(() => {
        if (!disposed)
          setSnapshot((current) => ({
            ...current,
            scope,
            loading: false,
            error: true,
          }));
      });
    return () => {
      disposed = true;
    };
  }, [userId, sessionId, scope, storageKey, revision, retry]);

  const selectBoard = useCallback(
    (selected: string) => {
      setSnapshot((current) =>
        current.scope === scope ? { ...current, selected } : current,
      );
      try {
        if (selected) sessionStorage.setItem(storageKey, selected);
        else sessionStorage.removeItem(storageKey);
      } catch {
        /* Selection remains available without browser storage. */
      }
    },
    [storageKey, scope],
  );
  const active = snapshot.scope === scope;
  const boards = active ? snapshot.boards : [];
  const selectedBoardId = active ? snapshot.selected : '';

  return {
    boards,
    selectedBoardId,
    currentBoard:
      boards.find((board) => board.source_message_id === selectedBoardId) ??
      boards[0],
    selectBoard,
    loading: Boolean(userId && sessionId) && (!active || snapshot.loading),
    error: active && snapshot.error,
    refresh: () => setRetry((current) => current + 1),
  };
}
