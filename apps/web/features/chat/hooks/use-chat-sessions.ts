'use client';

import {
  createElement,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';

import { chatSessionsApi, ChatSession } from '@/features/chat/api';
import { useAuth } from '@/features/auth/hooks/use-auth';

interface ChatSessionsContextValue {
  chatAvailable: boolean;
  sessions: ChatSession[];
  selectedSession: string;
  setSelectedSession: (id: string) => void;
  createSession: () => Promise<ChatSession | null>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  touchSession: (sessionId: string, patch: Partial<ChatSession>) => void;
  loading: boolean;
}

const ChatSessionsContext = createContext<ChatSessionsContextValue | null>(
  null,
);

function mergeSessionPatch(
  sessions: ChatSession[],
  sessionId: string,
  patch: Partial<ChatSession>,
) {
  const target = sessions.find((session) => session.id === sessionId);
  if (!target) {
    if (
      patch.id === sessionId &&
      typeof patch.account_id === 'string' &&
      typeof patch.title === 'string' &&
      typeof patch.created_at === 'string' &&
      typeof patch.updated_at === 'string'
    ) {
      return [
        patch as ChatSession,
        ...sessions.filter((session) => session.id !== sessionId),
      ];
    }
    return sessions;
  }

  const nextSession = { ...target, ...patch };
  return [
    nextSession,
    ...sessions.filter((session) => session.id !== sessionId),
  ];
}

function updateSessionTitle(
  sessions: ChatSession[],
  sessionId: string,
  title: string,
) {
  // 重命名只更新标题本身，不改变最近对话排序。
  return sessions.map((session) =>
    session.id === sessionId ? { ...session, title } : session,
  );
}

function readSelectedSessionFromUrl() {
  if (typeof window === 'undefined') {
    return '';
  }
  return new URLSearchParams(window.location.search).get('sid') || '';
}

export function ChatSessionsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [selectedSession, setSelectedSessionState] = useState('');
  const [loading, setLoading] = useState(false);

  const latestSessionsRequestRef = useRef(0);

  useEffect(() => {
    // 首次进入和浏览器前进/后退都从地址栏同步 sid，避免依赖 useSearchParams 触发整页 CSR。
    const syncSelectedSession = () => {
      setSelectedSessionState(readSelectedSessionFromUrl());
    };

    syncSelectedSession();
    window.addEventListener('popstate', syncSelectedSession);
    return () => window.removeEventListener('popstate', syncSelectedSession);
  }, []);

  const loadSessions = useCallback(async () => {
    if (!user) {
      setSessions([]);
      return;
    }

    const requestId = latestSessionsRequestRef.current + 1;
    latestSessionsRequestRef.current = requestId;
    setLoading(true);

    try {
      const list = await chatSessionsApi.list();
      if (latestSessionsRequestRef.current !== requestId) {
        return;
      }
      setSessions(list);
    } catch {
      if (latestSessionsRequestRef.current !== requestId) {
        return;
      }
      setSessions([]);
    } finally {
      if (latestSessionsRequestRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [user]);

  useEffect(() => {
    if (!user) {
      setSessions([]);
      setSelectedSessionState('');
      latestSessionsRequestRef.current = 0;
      return;
    }

    void loadSessions();
  }, [loadSessions, user]);

  const setSelectedSession = useCallback(
    (id: string) => {
      setSelectedSessionState(id);
      const target = id ? `/ai-chat?sid=${encodeURIComponent(id)}` : '/ai-chat';
      if (pathname === '/ai-chat') {
        window.history.replaceState(null, '', target);
      } else {
        router.push(target);
      }
    },
    [pathname, router],
  );

  const createSession = useCallback(async () => {
    if (!user) {
      return null;
    }

    const session = await chatSessionsApi.create();
    setSessions((previous) => [
      session,
      ...previous.filter((item) => item.id !== session.id),
    ]);
    setSelectedSession(session.id);
    return session;
  }, [setSelectedSession, user]);

  const renameSession = useCallback(async (sessionId: string, title: string) => {
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      throw new Error('标题不能为空');
    }

    await chatSessionsApi.update(sessionId, normalizedTitle);
    setSessions((previous) =>
      updateSessionTitle(previous, sessionId, normalizedTitle),
    );
  }, []);

  const deleteSession = useCallback(
    async (sessionId: string) => {
      await chatSessionsApi.remove(sessionId);
      setSessions((previous) =>
        previous.filter((session) => session.id !== sessionId),
      );
      if (selectedSession === sessionId) {
        setSelectedSession('');
      }
    },
    [selectedSession, setSelectedSession],
  );

  const touchSession = useCallback(
    (sessionId: string, patch: Partial<ChatSession>) => {
      // 对话一旦有新消息，应立即把该会话顶到最前，避免必须刷新后排序才正确。
      setSessions((previous) => mergeSessionPatch(previous, sessionId, patch));
    },
    [],
  );

  const value = useMemo<ChatSessionsContextValue>(
    () => ({
      chatAvailable: Boolean(user),
      sessions,
      selectedSession,
      setSelectedSession,
      createSession,
      renameSession,
      deleteSession,
      touchSession,
      loading,
    }),
    [
      user,
      sessions,
      selectedSession,
      setSelectedSession,
      createSession,
      renameSession,
      deleteSession,
      touchSession,
      loading,
    ],
  );

  return createElement(ChatSessionsContext.Provider, { value }, children);
}

export function useChatSessions() {
  const context = useContext(ChatSessionsContext);
  if (!context) {
    throw new Error('useChatSessions 必须在 ChatSessionsProvider 内使用');
  }
  return context;
}
