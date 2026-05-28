'use client';

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useSearchParams } from 'next/navigation';
import {
  admin,
  AdminChatSession,
  AdminMessage,
  AdminUser,
} from '@/lib/admin-api';
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  Loader2,
  MessageSquare,
  MonitorSmartphone,
  RefreshCw,
  Search,
  User,
} from 'lucide-react';
import { MarkdownContent } from '@/components/chat/markdown-content';

const SESSION_MESSAGE_PAGE_SIZE = 200;
const SESSION_FETCH_LIMIT = 200;

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDateTime(iso: string | null | undefined) {
  if (!iso) return '暂无';
  return new Date(iso).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function DeletedBadge() {
  return (
    <span className="inline-flex items-center rounded-full border border-error/30 bg-error/10 px-2 py-0.5 text-[10px] font-medium text-error">
      已删除
    </span>
  );
}

function formatDateLabel(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  return d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
}

function groupByDate(
  msgs: AdminMessage[],
): { label: string; date: string; messages: AdminMessage[] }[] {
  const groups: {
    label: string;
    date: string;
    messages: AdminMessage[];
  }[] = [];
  for (const msg of msgs) {
    const date = msg.timestamp.slice(0, 10);
    const last = groups[groups.length - 1];
    if (last && last.date === date) {
      last.messages.push(msg);
    } else {
      groups.push({
        label: formatDateLabel(msg.timestamp),
        date,
        messages: [msg],
      });
    }
  }
  return groups;
}

function MessageTimeline({
  messages,
  searchText,
  emptyText,
}: {
  messages: AdminMessage[];
  searchText: string;
  emptyText: string;
}) {
  const filtered = searchText
    ? messages.filter(
        (m) =>
          m.content.toLowerCase().includes(searchText.toLowerCase()) ||
          m.sender_name?.toLowerCase().includes(searchText.toLowerCase()) ||
          m.session_title?.toLowerCase().includes(searchText.toLowerCase()),
      )
    : messages;

  const sorted = [...filtered].reverse();
  const groups = groupByDate(sorted);

  if (sorted.length === 0) {
    return (
      <div className="text-center py-16">
        <MessageSquare
          size={24}
          className="mx-auto mb-2 text-muted"
        />
        <p className="text-[13px] text-muted">{emptyText}</p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto">
      {groups.map((group) => (
        <div key={group.date}>
          <div className="flex items-center gap-3 my-5">
            <div className="flex-1 h-px bg-hairline" />
            <span className="text-[11px] text-muted shrink-0">
              {group.label}
            </span>
            <div className="flex-1 h-px bg-hairline" />
          </div>

          <div className="space-y-3">
            {group.messages.map((msg) => {
              const isBot = msg.is_from_me || msg.is_bot_message;
              const isDeleted = Boolean(
                msg.deleted_at || msg.session_deleted_at,
              );
              return (
                <div
                  key={`${msg.id}-${msg.account_id}`}
                  className={`flex items-end gap-2 ${isBot ? '' : 'flex-row-reverse'}`}
                >
                  <div
                    className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
                      isBot
                        ? 'bg-primary/10 text-primary'
                        : 'bg-primary text-on-primary'
                    }`}
                  >
                    {isBot ? <Bot size={14} /> : <User size={14} />}
                  </div>

                  <div className="max-w-[80%] group relative">
                    {!isBot && (
                      <p className="text-[11px] text-muted mb-0.5 text-right mr-1">
                        {msg.sender_name || msg.sender}
                      </p>
                    )}
                    {isDeleted ? (
                      <div
                        className={`mb-1 px-1 flex ${
                          isBot ? 'justify-start' : 'justify-end'
                        }`}
                      >
                        <DeletedBadge />
                      </div>
                    ) : null}
                    <div
                      className={`rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed ${
                        isBot
                          ? 'bg-surface-card border border-hairline border-l-2 border-l-primary/60 rounded-bl-md'
                          : 'bg-primary text-on-primary rounded-br-md'
                      }`}
                    >
                      {isBot ? (
                        <MarkdownContent content={msg.content} isBot={isBot} />
                      ) : (
                        <p className="whitespace-pre-wrap break-words">
                          {msg.content}
                        </p>
                      )}
                    </div>
                    <p
                      className={`text-[10px] mt-1 px-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150 ${
                        isBot
                          ? 'text-muted text-left'
                          : 'text-muted text-right'
                      }`}
                    >
                      {formatTime(msg.timestamp)}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function AdminMessagesContent() {
  const searchParams = useSearchParams();
  const initialAccountId = searchParams.get('account_id') || '';
  const initialSessionId = searchParams.get('session_id') || '';

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [messages, setMessages] = useState<AdminMessage[]>([]);
  const [sessions, setSessions] = useState<AdminChatSession[]>([]);
  const [total, setTotal] = useState(0);
  const [sessionsTotal, setSessionsTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [msgLoading, setMsgLoading] = useState(false);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [error, setError] = useState('');

  const [selectedUserId, setSelectedUserId] = useState(
    searchParams.get('user_id') || '',
  );
  const [selectedAccountId, setSelectedAccountId] = useState(initialAccountId);
  const [selectedSessionId, setSelectedSessionId] = useState(initialSessionId);
  const [accounts, setAccounts] = useState<
    { id: string; name: string; enabled: boolean }[]
  >([]);
  const [page, setPage] = useState(0);
  const [searchText, setSearchText] = useState('');

  const prevUserIdRef = useRef(selectedUserId);
  const prevAccountIdRef = useRef(selectedAccountId);
  const initialSessionIdRef = useRef(initialSessionId);

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) || null,
    [sessions, selectedSessionId],
  );

  const loadUsers = useCallback(async () => {
    try {
      const u = await admin.users();
      setUsers(u);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAccounts = useCallback(async (userId: string) => {
    if (!userId) {
      setAccounts([]);
      return;
    }
    try {
      const detail = await admin.userDetail(userId);
      setAccounts(
        detail.accounts.map((a) => ({
          id: a.id,
          name: a.name || a.id,
          enabled: a.enabled,
        })),
      );
    } catch {
      setAccounts([]);
    }
  }, []);

  const loadMessages = useCallback(
    async (sessionId: string) => {
      setMsgLoading(true);
      try {
        const result = await admin.messages({
          user_id: selectedUserId || undefined,
          account_id: selectedAccountId || undefined,
          session_id: sessionId,
          limit: SESSION_MESSAGE_PAGE_SIZE,
          offset: page * SESSION_MESSAGE_PAGE_SIZE,
        });
        setMessages(result.messages);
        setTotal(result.total);
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载消息失败');
      } finally {
        setMsgLoading(false);
      }
    },
    [page, selectedAccountId, selectedUserId],
  );

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const result = await admin.chatSessions({
        user_id: selectedUserId || undefined,
        account_id: selectedAccountId || undefined,
        limit: SESSION_FETCH_LIMIT,
      });
      setSessions(result.sessions);
      setSessionsTotal(result.total);
      setSelectedSessionId((current) => {
        if (
          current &&
          result.sessions.some((session) => session.id === current)
        ) {
          return current;
        }
        if (
          initialSessionIdRef.current &&
          result.sessions.some(
            (session) => session.id === initialSessionIdRef.current,
          )
        ) {
          const next = initialSessionIdRef.current;
          initialSessionIdRef.current = '';
          return next;
        }
        initialSessionIdRef.current = '';
        return result.sessions[0]?.id || '';
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载网页会话失败');
      setSessions([]);
      setSessionsTotal(0);
      setSelectedSessionId('');
    } finally {
      setSessionsLoading(false);
    }
  }, [selectedAccountId, selectedUserId]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  useEffect(() => {
    void loadAccounts(selectedUserId);
    if (prevUserIdRef.current !== selectedUserId) {
      setSelectedAccountId('');
      setSelectedSessionId('');
      setPage(0);
    }
    prevUserIdRef.current = selectedUserId;
  }, [loadAccounts, selectedUserId]);

  useEffect(() => {
    if (prevAccountIdRef.current !== selectedAccountId) {
      setSelectedSessionId('');
      setPage(0);
    }
    prevAccountIdRef.current = selectedAccountId;
  }, [selectedAccountId]);

  useEffect(() => {
    if (loading) return;
    void loadSessions();
  }, [loadSessions, loading]);

  useEffect(() => {
    if (loading) return;
    if (!selectedSessionId) {
      setMessages([]);
      setTotal(0);
      return;
    }
    void loadMessages(selectedSessionId);
  }, [loadMessages, loading, selectedSessionId]);

  const filteredSessions =
    searchText
      ? sessions.filter(
          (session) =>
            session.title.toLowerCase().includes(searchText.toLowerCase()) ||
            session.account_name
              .toLowerCase()
              .includes(searchText.toLowerCase()) ||
            (session.owner_phone || '').includes(searchText) ||
            session.last_message_preview
              ?.toLowerCase()
              .includes(searchText.toLowerCase()),
        )
      : sessions;

  const totalPages = Math.ceil(total / SESSION_MESSAGE_PAGE_SIZE);

  const handleRefresh = useCallback(() => {
    void loadSessions();
    if (selectedSessionId) {
      void loadMessages(selectedSessionId);
    }
  }, [loadMessages, loadSessions, selectedSessionId]);

  return (
    <>
      {loading ? (
        <div className="flex justify-center py-20">
          <Loader2
            size={20}
            className="animate-spin text-muted"
          />
        </div>
      ) : error ? (
        <div className="text-center py-20">
          <p className="text-[13px] text-error">{error}</p>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-3 mb-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="flex items-center gap-2 flex-wrap min-w-0">
                <MessageSquare
                  size={16}
                  className="text-muted shrink-0"
                />
                <h2 className="text-lg font-semibold shrink-0">对话查看</h2>
                <span className="text-[12px] text-muted shrink-0">
                  ({sessionsTotal.toLocaleString()})
                </span>
                <button
                  onClick={handleRefresh}
                  className="p-1.5 rounded-md text-muted hover:text-ink transition-colors cursor-pointer"
                  title="刷新"
                >
                  <RefreshCw size={13} />
                </button>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-2">
              <div className="flex flex-wrap items-center gap-2 flex-1">
                <select
                  value={selectedUserId}
                  onChange={(e) => setSelectedUserId(e.target.value)}
                  className="h-8 px-2 rounded-md border border-hairline bg-canvas text-[13px] focus:outline-none cursor-pointer max-w-[200px]"
                >
                  <option value="">全部用户</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.phone}
                    </option>
                  ))}
                </select>

                {selectedUserId && accounts.length > 0 && (
                  <select
                    value={selectedAccountId}
                    onChange={(e) => setSelectedAccountId(e.target.value)}
                    className="h-8 px-2 rounded-md border border-hairline bg-canvas text-[13px] focus:outline-none cursor-pointer max-w-[200px]"
                  >
                    <option value="">全部账号</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                )}

                <div className="flex items-center gap-1.5 text-[12px] text-muted">
                  <MonitorSmartphone size={14} />
                  <span>仅显示网页产生的对话窗口</span>
                </div>
              </div>

              <div className="relative">
                <Search
                  size={12}
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
                />
                <input
                  type="text"
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  placeholder="搜索会话或内容..."
                  className="h-8 w-44 pl-7 pr-2 rounded-md border border-hairline bg-canvas text-[13px] placeholder:text-muted focus:outline-none"
                />
              </div>
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
            <div className="rounded-2xl border border-hairline bg-surface-card p-3">
              <div className="flex items-center justify-between gap-2 mb-3">
                <div>
                  <p className="text-[13px] font-medium">网页对话窗口</p>
                  <p className="text-[11px] text-muted">
                    最近 {Math.min(sessionsTotal, SESSION_FETCH_LIMIT)} /{' '}
                    {sessionsTotal}
                  </p>
                </div>
              </div>

              {sessionsLoading ? (
                <div className="flex justify-center py-10">
                  <Loader2
                    size={16}
                    className="animate-spin text-muted"
                  />
                </div>
              ) : filteredSessions.length === 0 ? (
                <div className="text-center py-10">
                  <MonitorSmartphone
                    size={20}
                    className="mx-auto mb-2 text-muted"
                  />
                  <p className="text-[12px] text-muted">
                    {searchText ? '无匹配会话' : '暂无网页会话'}
                  </p>
                </div>
              ) : (
                <div className="space-y-2 max-h-[72vh] overflow-y-auto pr-1">
                  {filteredSessions.map((session) => {
                    const active = session.id === selectedSessionId;
                    return (
                      <button
                        key={session.id}
                        onClick={() => {
                          setSelectedSessionId(session.id);
                          setPage(0);
                        }}
                        className={`w-full text-left rounded-xl border p-3 transition-colors cursor-pointer ${
                          active
                            ? 'border-primary bg-primary/8'
                            : 'border-hairline hover:border-primary/40 hover:bg-canvas'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 min-w-0">
                              <p className="text-[13px] font-medium truncate">
                                {session.title || '未命名会话'}
                              </p>
                              {session.deleted_at ? <DeletedBadge /> : null}
                            </div>
                            <p className="text-[11px] text-muted mt-0.5 truncate">
                              {session.account_name}
                              {session.owner_phone
                                ? ` · ${session.owner_phone}`
                                : ''}
                            </p>
                          </div>
                          <span className="text-[10px] text-muted shrink-0">
                            {session.message_count} 条
                          </span>
                        </div>
                        <p className="text-[11px] text-muted mt-2 line-clamp-2 min-h-[2rem]">
                          {session.last_message_preview || '暂无消息'}
                        </p>
                        <p className="text-[10px] text-muted mt-2">
                          更新于{' '}
                          {formatDateTime(
                            session.last_message_at || session.updated_at,
                          )}
                        </p>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-hairline bg-surface-card p-4">
              {!selectedSession ? (
                <div className="text-center py-16">
                  <MonitorSmartphone
                    size={26}
                    className="mx-auto mb-3 text-muted"
                  />
                  <p className="text-[13px] text-muted">
                    选择左侧会话后可查看完整对话窗口
                  </p>
                </div>
              ) : (
                <>
                  <div className="rounded-xl border border-hairline bg-canvas/60 px-4 py-3 mb-4">
                    <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <h3 className="text-[15px] font-semibold truncate">
                            {selectedSession.title || '未命名会话'}
                          </h3>
                          {selectedSession.deleted_at ? (
                            <DeletedBadge />
                          ) : null}
                        </div>
                        <p className="text-[12px] text-muted mt-1">
                          {selectedSession.account_name}
                          {selectedSession.owner_phone
                            ? ` · ${selectedSession.owner_phone}`
                            : ''}
                        </p>
                      </div>
                      <div className="text-[11px] text-muted md:text-right">
                        <p>{selectedSession.message_count} 条消息</p>
                        <p>
                          最近更新{' '}
                          {formatDateTime(
                            selectedSession.last_message_at ||
                              selectedSession.updated_at,
                          )}
                        </p>
                        {selectedSession.deleted_at ? (
                          <p>
                            删除时间 {formatDateTime(selectedSession.deleted_at)}
                          </p>
                        ) : null}
                      </div>
                    </div>
                    <p className="text-[11px] text-muted mt-2 font-mono break-all">
                      session: {selectedSession.id}
                    </p>
                  </div>

                  {msgLoading ? (
                    <div className="flex justify-center py-16">
                      <Loader2
                        size={16}
                        className="animate-spin text-muted"
                      />
                    </div>
                  ) : (
                    <MessageTimeline
                      messages={messages}
                      searchText={searchText}
                      emptyText={
                        searchText ? '当前会话无匹配消息' : '当前会话暂无消息'
                      }
                    />
                  )}
                </>
              )}
            </div>
          </div>

          {selectedSession && totalPages > 1 ? (
            <div className="flex items-center justify-center gap-3 mt-6">
              <button
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-hairline text-[13px] text-muted hover:text-ink disabled:opacity-30 cursor-pointer transition-colors"
              >
                <ChevronLeft size={14} />
                <span>更早</span>
              </button>
              <span className="text-[13px] text-muted">
                {page + 1} / {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-hairline text-[13px] text-muted hover:text-ink disabled:opacity-30 cursor-pointer transition-colors"
              >
                <span>更近</span>
                <ChevronRight size={14} />
              </button>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}

export default function AdminMessagesPage() {
  return (
    <Suspense>
      <AdminMessagesContent />
    </Suspense>
  );
}
