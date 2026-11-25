'use client';

import { useCallback, useRef, useState, type RefObject } from 'react';

import type { ChatSessionStreamEvent } from '../api';
import {
  acceptsChatStreamRequest,
  type ChatRunPhase,
  type ChatRunState,
} from '../utils/run-state';

const MAX_SETTLED_REQUEST_IDS = 128;

function isSettled(phase: ChatRunPhase) {
  return phase === 'completed' || phase === 'failed' || phase === 'stopped';
}

export function useChatRun(activeSessionRef: RefObject<string>) {
  const [run, setRun] = useState<ChatRunState>({
    sessionId: '',
    requestId: null,
    phase: 'idle',
    error: null,
  });
  const runRef = useRef(run);
  const settledRequestIdsRef = useRef(new Set<string>());

  const transitionRun = useCallback(
    (
      sessionId: string,
      phase: ChatRunPhase,
      requestId?: string | null,
      error: string | null = null,
    ) => {
      if (activeSessionRef.current !== sessionId) return;
      const previous = runRef.current;
      const next = {
        sessionId,
        phase,
        requestId: requestId === undefined ? previous.requestId : requestId,
        error,
      };
      if (
        previous.sessionId === next.sessionId &&
        previous.phase === next.phase &&
        previous.requestId === next.requestId &&
        previous.error === next.error
      ) {
        return;
      }

      runRef.current = next;
      if (next.requestId && isSettled(phase)) {
        const settledRequestIds = settledRequestIdsRef.current;
        settledRequestIds.add(next.requestId);
        if (settledRequestIds.size > MAX_SETTLED_REQUEST_IDS) {
          const oldest = settledRequestIds.values().next();
          if (!oldest.done) settledRequestIds.delete(oldest.value);
        }
      }
      setRun(next);
    },
    [activeSessionRef],
  );

  const acceptRunEvent = useCallback(
    (sessionId: string, event: ChatSessionStreamEvent) => {
      const { requestId, type } = event;
      if (requestId && settledRequestIdsRef.current.has(requestId)) return null;

      const current = runRef.current;
      if (!acceptsChatStreamRequest(current.requestId, requestId)) {
        if (
          (current.phase === 'idle' || isSettled(current.phase)) &&
          (type === 'agent_start' || type === 'turn_start')
        ) {
          transitionRun(sessionId, 'running', requestId);
          return 'new-request';
        }
        return null;
      }

      if (requestId && !current.requestId) {
        transitionRun(sessionId, 'running', requestId);
      }
      return 'current-request';
    },
    [transitionRun],
  );

  return { run, runRef, transitionRun, acceptRunEvent };
}
