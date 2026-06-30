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
  selectedSessionRevision: number;
  setSelectedSession: (id: string) => void;
  createSession: () => Promise<ChatSession | null>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  archiveSession: (sessionId: string) => Promise<void>;
  restoreSession: (sessionId: string) => Promise<ChatSession>;
  shareSession: (sessionId: string) => Promise<string>;
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

/**
 * 判断给定 pathname 是否指向 AI Chat 页。
 *
 * 生产构建启用 trailingSlash:true，usePathname() 在聊天页返回的是带尾斜杠的 '/ai-chat/'。
 * 若直接用 `pathname === '/ai-chat'` 比较，生产环境恒为 false——会导致：
 *   1) 聊天页内切换/新建会话误走 router.push（而非原地 replaceState），破坏「不重挂 Provider、
 *      靠 selectedSession state 切换」的设计，并叠加挂载期读 URL 的竞态，出现「新建却进上一个对话」；
 *   2) 侧栏当前会话高亮失效、备案页脚显示判断错误等次生问题。
 * 这里去掉尾部斜杠后再比较，同时兼容开发('/ai-chat')与生产('/ai-chat/')两种返回值。
 */
export function isAiChatPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return pathname.replace(/\/+$/, '') === '/ai-chat';
}

// 新建对话导航用的一次性 query 参数名：仅为让 router.push 的目标 URL 唯一，
// 绕开 Next App Router 对「导航到与缓存/历史相同 URL」做的树/状态复用；
// 不承载任何业务语义，落地 /ai-chat 后会被立刻从地址栏清掉。
const NEW_CHAT_QUERY_KEY = 'new';

/**
 * 生成「新建空白对话」的导航目标（带一次性 nonce 保证 URL 唯一）。
 *
 * 必须只在事件回调里调用：nonce 用 Date.now()/Math.random() 生成，若在渲染期执行会让
 * 静态导出（构建时预渲染）与客户端首屏不一致而 hydration 报错；事件回调发生在 hydration
 * 之后，安全。
 */
function buildNewChatTarget() {
  const nonce = `${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 7)}`;
  return `/ai-chat?${NEW_CHAT_QUERY_KEY}=${nonce}`;
}

function hasStoredAuthToken() {
  return typeof window !== 'undefined' && Boolean(localStorage.getItem('token'));
}

/**
 * 判断是否应该清空当前 AI Chat 会话选择。
 *
 * @param args.user 当前认证用户，未登录时为 null。
 * @param args.authLoading 认证会话是否仍在初始化。
 * @param args.hasToken 本地是否仍有登录 token。
 * @returns 只有确认未登录时才返回 true。
 *
 * 注意：登录态确认前必须保留当前会话选择，避免 auth 初始化的短暂空用户
 * 把 /ai-chat?sid=... 误清成新对话首页。若 token 仍在但 /me 临时失败，
 * 也先保留会话选择，避免网络抖动直接把聊天界面清空。
 */
export function shouldClearChatSelection(args: {
  user: unknown;
  authLoading: boolean;
  hasToken: boolean;
}) {
  return !args.authLoading && !args.user && !args.hasToken;
}

export function ChatSessionsProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  const [sessions, setSessions] = useState<ChatSession[]>([]);
  // 选中会话与其修订号始终成对更新（每次切换/同步都要 bump revision），
  // 合并到同一个 state 用一次 setSelection 翻转，避免分散的双 setState 级联重渲染。
  const [selection, setSelection] = useState<{ id: string; revision: number }>({
    id: '',
    revision: 0,
  });
  const selectedSession = selection.id;
  const selectedSessionRevision = selection.revision;
  const [loading, setLoading] = useState(false);

  const latestSessionsRequestRef = useRef(0);

  // 切换/同步选中会话：替换 id 并自增 revision，保持「每次选择都触发一次显示切换」语义。
  const applySelectedSession = useCallback((id: string) => {
    setSelection((previous) => ({ id, revision: previous.revision + 1 }));
  }, []);

  useEffect(() => {
    // 首次进入和浏览器前进/后退都从地址栏同步 sid，避免依赖 useSearchParams 触发整页 CSR。
    const syncSelectedSession = () => {
      applySelectedSession(readSelectedSessionFromUrl());
    };

    syncSelectedSession();

    // 新建对话仅用一次性 nonce 强制 URL 唯一，落地后立刻从地址栏抹掉，
    // 保持空白新对话 URL 干净（此时 selectedSession 已同步为空，不再依赖该参数）。
    if (
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).has(NEW_CHAT_QUERY_KEY)
    ) {
      window.history.replaceState(window.history.state, '', '/ai-chat');
    }

    window.addEventListener('popstate', syncSelectedSession);
    return () => window.removeEventListener('popstate', syncSelectedSession);
  }, [applySelectedSession]);

  const loadSessions = useCallback(async () => {
    if (authLoading) {
      return;
    }

    if (!user && !hasStoredAuthToken()) {
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
    } finally {
      if (latestSessionsRequestRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [authLoading, user]);

  useEffect(() => {
    const hasToken = hasStoredAuthToken();
    if (shouldClearChatSelection({ user, authLoading, hasToken })) {
      setSessions([]);
      applySelectedSession('');
      latestSessionsRequestRef.current = 0;
      return;
    }

    if (authLoading) {
      return;
    }

    void loadSessions();
  }, [applySelectedSession, authLoading, loadSessions, user]);

  const setSelectedSession = useCallback(
    (id: string) => {
      applySelectedSession(id);
      if (isAiChatPath(pathname)) {
        // 已在聊天页：原地替换 URL 即可，靠 selectedSession state + revision 切换显示，
        // 避免触发整页软导航/重挂 Provider。
        // 保留 Next App Router 写入的 history state，避免后续导航恢复到错误页面。
        const target = id ? `/ai-chat?sid=${encodeURIComponent(id)}` : '/ai-chat';
        window.history.replaceState(window.history.state, '', target);
      } else {
        // 从其它页（如主页工作台）进入聊天页：用 router.push 软导航。新建（id 为空）时带
        // 一次性 nonce 让目标 URL 唯一，绕开 Next 对「相同 URL」的树/状态复用——否则从聊天页
        // 回主页再点新建时，push('/ai-chat') 可能落回上一个会话的旧状态（即用户反馈的误跳）。
        const target = id
          ? `/ai-chat?sid=${encodeURIComponent(id)}`
          : buildNewChatTarget();
        router.push(target);
      }
    },
    [applySelectedSession, pathname, router],
  );

  const createSession = useCallback(async () => {
    if (authLoading || (!user && !hasStoredAuthToken())) {
      return null;
    }

    const session = await chatSessionsApi.create();
    setSessions((previous) => [
      session,
      ...previous.filter((item) => item.id !== session.id),
    ]);
    setSelectedSession(session.id);
    return session;
  }, [authLoading, setSelectedSession, user]);

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

  const archiveSession = useCallback(
    async (sessionId: string) => {
      await chatSessionsApi.archive(sessionId);
      setSessions((previous) =>
        previous.filter((session) => session.id !== sessionId),
      );
      if (selectedSession === sessionId) {
        setSelectedSession('');
      }
    },
    [selectedSession, setSelectedSession],
  );

  const restoreSession = useCallback(async (sessionId: string) => {
    const session = await chatSessionsApi.restore(sessionId);
    setSessions((previous) =>
      mergeSessionPatch(previous, session.id, session),
    );
    return session;
  }, []);

  const shareSession = useCallback(async (sessionId: string) => {
    const result = await chatSessionsApi.share(sessionId);
    setSessions((previous) =>
      previous.map((session) =>
        session.id === sessionId ? result.session : session,
      ),
    );
    return result.share_token;
  }, []);

  const touchSession = useCallback(
    (sessionId: string, patch: Partial<ChatSession>) => {
      // 对话一旦有新消息，应立即把该会话顶到最前，避免必须刷新后排序才正确。
      setSessions((previous) => mergeSessionPatch(previous, sessionId, patch));
    },
    [],
  );

  const value = useMemo<ChatSessionsContextValue>(
    () => ({
      chatAvailable: !authLoading && (Boolean(user) || hasStoredAuthToken()),
      sessions,
      selectedSession,
      selectedSessionRevision,
      setSelectedSession,
      createSession,
      renameSession,
      archiveSession,
      restoreSession,
      shareSession,
      touchSession,
      loading,
    }),
    [
      authLoading,
      user,
      sessions,
      selectedSession,
      selectedSessionRevision,
      setSelectedSession,
      createSession,
      renameSession,
      archiveSession,
      restoreSession,
      shareSession,
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
