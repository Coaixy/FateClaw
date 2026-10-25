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
import { toAdminDocumentHref } from '@/lib/admin-navigation';
import {
  admin,
  AdminChatSession,
  AdminMessage,
  type AdminPiSessionOrphanScanResult,
  AdminUser,
} from '@/lib/admin-api';
import {
  ChevronLeft,
  ChevronRight,
  Eye,
  Loader2,
  MessageSquare,
  MonitorSmartphone,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import { AdminSessionDetailModal } from '@/components/chat/admin-session-detail-modal';
import {
  DeletedBadge,
  MessageTimeline,
} from '@/components/messages/message-timeline';
import { AdminSearchInput } from '@/components/ui/admin-search';
import { AdminCopyButton } from '@/components/ui/admin-controls';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { useConfirm } from '@/lib/use-confirm';
import { useToast } from '@/lib/use-toast';
import { useAdminSession } from '@/lib/admin-session';
import type { MessageDto } from '@fateclaw/contracts/chat';

const SESSION_MESSAGE_PAGE_SIZE = 200;
const SESSION_FETCH_LIMIT = 200;

function replaceMessagesQuery(input: {
  userId: string;
  accountId: string;
  sessionId: string;
}) {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams();
  if (input.userId) params.set('user_id', input.userId);
  if (input.accountId) params.set('account_id', input.accountId);
  if (input.sessionId) params.set('session_id', input.sessionId);
  const query = params.toString();
  window.history.replaceState(
    null,
    '',
    toAdminDocumentHref(`/messages${query ? `?${query}` : ''}`),
  );
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

function AdminMessagesContent() {
  const searchParams = useSearchParams();
  const { confirm } = useConfirm();
  const { toast } = useToast();
  const { role } = useAdminSession();
  const initialAccountId = searchParams.get('account_id') || '';
  const initialSessionId = searchParams.get('session_id') || '';

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [messages, setMessages] = useState<AdminMessage[]>([]);
  const [fullMessages, setFullMessages] = useState<MessageDto[]>([]);
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
  // 「查看完整详情」弹层目标会话 id；非空时挂载详情弹层（像用户一样看完整对话）。
  const [detailSessionId, setDetailSessionId] = useState('');
  const [accounts, setAccounts] = useState<
    { id: string; name: string; enabled: boolean }[]
  >([]);
  const [page, setPage] = useState(0);
  const [searchText, setSearchText] = useState('');
  // 会话/消息内搜索为纯客户端过滤，输入即时回显、用 200ms 防抖驱动过滤与消息高亮，避免抖动。
  const debouncedSearchText = useDebouncedValue(searchText, 200);
  const [inactiveDays, setInactiveDays] = useState('30');
  const [cleanupLoading, setCleanupLoading] = useState<
    'soft_deleted' | 'inactive' | null
  >(null);
  const [orphanLoading, setOrphanLoading] = useState<
    'audit' | 'delete' | null
  >(null);
  const [orphanResult, setOrphanResult] =
    useState<AdminPiSessionOrphanScanResult | null>(null);

  const prevUserIdRef = useRef(selectedUserId);
  const prevAccountIdRef = useRef(selectedAccountId);
  const initialSessionIdRef = useRef(initialSessionId);
  const messageRequestRef = useRef(0);

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) || null,
    [sessions, selectedSessionId],
  );

  const loadUsers = useCallback(async () => {
    try {
      const result = await admin.users({ page_size: 100 });
      setUsers(result.items);
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
      const requestId = ++messageRequestRef.current;
      setMsgLoading(true);
      setMessages([]);
      setFullMessages([]);
      try {
        // Keep the audit page and its deletion flags; only owners can enrich it with artifacts.
        const [result, detail] = await Promise.all([
          admin.messages({
            user_id: selectedUserId || undefined,
            account_id: selectedAccountId || undefined,
            session_id: sessionId,
            limit: SESSION_MESSAGE_PAGE_SIZE,
            offset: page * SESSION_MESSAGE_PAGE_SIZE,
          }),
          role === 'owner' ? admin.chatSessionDetail(sessionId) : null,
        ]);
        if (requestId !== messageRequestRef.current) return;
        setMessages(result.messages);
        setFullMessages(detail?.messages ?? []);
        setTotal(result.total);
      } catch (err) {
        if (requestId !== messageRequestRef.current) return;
        setError(err instanceof Error ? err.message : '加载消息失败');
      } finally {
        if (requestId === messageRequestRef.current) setMsgLoading(false);
      }
    },
    [page, role, selectedAccountId, selectedUserId],
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
      setFullMessages([]);
      setTotal(0);
      return;
    }
    void loadMessages(selectedSessionId);
    return () => {
      messageRequestRef.current += 1;
    };
  }, [loadMessages, loading, selectedSessionId]);

  useEffect(() => {
    replaceMessagesQuery({
      userId: selectedUserId,
      accountId: selectedAccountId,
      sessionId: selectedSessionId,
    });
  }, [selectedAccountId, selectedSessionId, selectedUserId]);

  const filteredSessions = debouncedSearchText
    ? sessions.filter(
        (session) =>
          session.title
            .toLowerCase()
            .includes(debouncedSearchText.toLowerCase()) ||
          session.account_name
            .toLowerCase()
            .includes(debouncedSearchText.toLowerCase()) ||
          (session.owner_phone || '').includes(debouncedSearchText) ||
          session.last_message_preview
            ?.toLowerCase()
            .includes(debouncedSearchText.toLowerCase()),
      )
    : sessions;

  const totalPages = Math.ceil(total / SESSION_MESSAGE_PAGE_SIZE);

  const handleRefresh = useCallback(() => {
    void loadSessions();
    if (selectedSessionId) {
      void loadMessages(selectedSessionId);
    }
  }, [loadMessages, loadSessions, selectedSessionId]);

  const runPiSessionCleanup = useCallback(
    async (mode: 'soft_deleted' | 'inactive') => {
      if (cleanupLoading) return;
      const days = Number(inactiveDays);
      if (mode === 'inactive' && (!Number.isInteger(days) || days <= 0)) {
        toast('error', '请输入有效的未活跃天数');
        return;
      }

      const ok = await confirm({
        title:
          mode === 'soft_deleted'
            ? '清理已归档文件'
            : '归档并清理超期文件',
        message:
          mode === 'soft_deleted'
            ? '确定要删除已经有数据库归档 payload 的 Pi session 本地 jsonl/path 文件吗？数据库消息不会删除。'
            : `确定要处理 ${days} 天未活跃对话吗？系统会先把可恢复 payload 写入数据库，再删除本地 jsonl/path 文件。`,
        confirmLabel: '开始处理',
        variant: 'danger',
      });
      if (!ok) return;

      setCleanupLoading(mode);
      try {
        const result = await admin.cleanupPiSessions({
          mode,
          inactive_days: mode === 'inactive' ? days : undefined,
        });
        toast(
          'success',
          `扫描 ${result.scanned_sessions} 个，新增归档 ${result.archived_sessions} 个，复用 ${result.already_archived_sessions} 个，snapshot 修复 ${result.payload_restored_from_snapshot} 个，无法归档 ${result.unarchivable_sessions} 个；删除 ${result.deleted_jsonl_files} 个 jsonl、${result.deleted_path_files} 个 path`,
        );
        handleRefresh();
      } catch (err) {
        toast('error', err instanceof Error ? err.message : '清理失败');
      } finally {
        setCleanupLoading(null);
      }
    },
    [cleanupLoading, confirm, handleRefresh, inactiveDays, toast],
  );

  const runPiSessionOrphanScan = useCallback(
    async (action: 'audit' | 'delete') => {
      if (orphanLoading) return;
      if (action === 'delete') {
        const ok = await confirm({
          title: '删除安全孤儿文件',
          message:
            '确定要删除已通过数据库归档状态校验的 Pi session 孤儿文件吗？未知文件、unsafe path 和未归档会话都会跳过。',
          confirmLabel: '删除',
          variant: 'danger',
        });
        if (!ok) return;
      }

      setOrphanLoading(action);
      try {
        const result = await admin.scanPiSessionOrphans({
          action,
          sample_limit: 10,
        });
        setOrphanResult(result);
        toast(
          'success',
          action === 'delete'
            ? `扫描 ${result.scanned_files} 个文件，删除 ${result.deleted_jsonl_files} 个 jsonl、${result.deleted_path_files} 个 path`
            : `扫描 ${result.scanned_files} 个文件，安全可删 ${result.safe_deletable_files} 个，未知 ${result.unknown_files} 个，unsafe ${result.unsafe_path_files} 个`,
        );
        if (action === 'delete') {
          handleRefresh();
        }
      } catch (err) {
        toast('error', err instanceof Error ? err.message : '孤儿文件扫描失败');
      } finally {
        setOrphanLoading(null);
      }
    },
    [confirm, handleRefresh, orphanLoading, toast],
  );

  return (
    <>
      {loading ? (
        <div className="flex justify-center py-20">
          <Loader2 size={20} className="animate-spin text-muted" />
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
                <MessageSquare size={16} className="text-muted shrink-0" />
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

              {/* 会话/消息内搜索：统一搜索框（自带图标 + 一键清除），输入即时过滤、防抖驱动 */}
              <AdminSearchInput
                value={searchText}
                onValueChange={setSearchText}
                placeholder="搜索会话或内容..."
                className="w-full sm:w-56"
              />
            </div>

            <details className="rounded-xl border border-hairline bg-surface-card px-3 py-2.5">
              <summary className="cursor-pointer text-[12px] font-medium text-muted marker:text-muted">
                高级：Pi session 文件维护
              </summary>
              <div className="mt-3 flex flex-col gap-2 border-t border-hairline/70 pt-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-[12px] font-medium">按会话清理</p>
                  <p className="text-[11px] text-muted">
                    处理能对应到数据库 session 的本地 jsonl/path；必要时先生成可恢复 payload
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void runPiSessionCleanup('soft_deleted')}
                    disabled={cleanupLoading !== null}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline px-2.5 text-[12px] text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {cleanupLoading === 'soft_deleted' ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Trash2 size={13} />
                    )}
                    清理已归档文件
                  </button>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      min={1}
                      max={3650}
                      value={inactiveDays}
                      onChange={(event) => setInactiveDays(event.target.value)}
                      className="h-8 w-16 rounded-md border border-hairline bg-canvas px-2 text-[12px] focus:outline-none"
                    />
                    <span className="text-[12px] text-muted">天未活跃</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void runPiSessionCleanup('inactive')}
                    disabled={cleanupLoading !== null}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md bg-error px-2.5 text-[12px] font-medium text-on-primary transition-colors hover:bg-error/90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {cleanupLoading === 'inactive' ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Trash2 size={13} />
                    )}
                    归档并清理超期
                  </button>
                </div>
              </div>
              <div className="mt-3 flex flex-col gap-2 border-t border-hairline/70 pt-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-[12px] font-medium">孤儿文件</p>
                  <p className="text-[11px] text-muted">
                    先扫描未被 path 引用的文件；只有超过保护天数且 DB 可确认安全的文件才允许删除
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void runPiSessionOrphanScan('audit')}
                    disabled={orphanLoading !== null}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline px-2.5 text-[12px] text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {orphanLoading === 'audit' ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Search size={13} />
                    )}
                    扫描孤儿文件
                  </button>
                  {orphanResult?.action === 'audit' &&
                  orphanResult.safe_deletable_files > 0 ? (
                    <button
                      type="button"
                      onClick={() => void runPiSessionOrphanScan('delete')}
                      disabled={orphanLoading !== null}
                      className="inline-flex h-8 items-center gap-1.5 rounded-md bg-error px-2.5 text-[12px] font-medium text-on-primary transition-colors hover:bg-error/90 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {orphanLoading === 'delete' ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : (
                        <Trash2 size={13} />
                      )}
                      删除安全项
                    </button>
                  ) : null}
                </div>
              </div>
              {orphanResult ? (
                <div className="mt-2 grid gap-2 text-[11px] text-muted sm:grid-cols-2 xl:grid-cols-4">
                  <div>
                    扫描 {orphanResult.scanned_files}/
                    {orphanResult.total_files} 个
                    {orphanResult.truncated ? '，已截断' : ''}
                  </div>
                  <div>
                    可安全删除 {orphanResult.safe_deletable_files} 个，已删{' '}
                    {orphanResult.deleted_jsonl_files +
                      orphanResult.deleted_path_files}{' '}
                    个
                  </div>
                  <div>
                    dangling {orphanResult.dangling_path_files} / unmapped{' '}
                    {orphanResult.unmapped_jsonl_files}
                  </div>
                  <div>
                    跳过 recent {orphanResult.skipped_recent_files} / 未归档{' '}
                    {orphanResult.skipped_unarchived_files} / unknown{' '}
                    {orphanResult.unknown_files}
                  </div>
                </div>
              ) : null}
            </details>
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
                  <Loader2 size={16} className="animate-spin text-muted" />
                </div>
              ) : filteredSessions.length === 0 ? (
                <div className="text-center py-10">
                  <MonitorSmartphone
                    size={20}
                    className="mx-auto mb-2 text-muted"
                  />
                  <p className="text-[12px] text-muted">
                    {debouncedSearchText ? '无匹配会话' : '暂无网页会话'}
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
                            ? 'border-primary bg-primary/10 ring-1 ring-primary/30 shadow-sm'
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
                              {session.pi_session_archived_at ? (
                                <span className="inline-flex items-center rounded-full border border-primary/25 bg-primary/8 px-2 py-0.5 text-[10px] font-medium text-primary">
                                  已归档
                                </span>
                              ) : null}
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
                          {selectedSession.deleted_at ? <DeletedBadge /> : null}
                          {selectedSession.pi_session_archived_at ? (
                            <span className="inline-flex items-center rounded-full border border-primary/25 bg-primary/8 px-2 py-0.5 text-[10px] font-medium text-primary">
                              Pi 已归档
                            </span>
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
                            删除时间{' '}
                            {formatDateTime(selectedSession.deleted_at)}
                          </p>
                        ) : null}
                        {selectedSession.pi_session_archived_at ? (
                          <p>
                            Pi 归档{' '}
                            {formatDateTime(
                              selectedSession.pi_session_archived_at,
                            )}
                          </p>
                        ) : null}
                      </div>
                    </div>
                    <div className="mt-2 flex items-start gap-1 text-[11px] text-muted">
                      <span className="font-mono break-all">
                        session: {selectedSession.id}
                      </span>
                      {/* session id 旁一键复制，方便排查时直接取用 */}
                      <AdminCopyButton text={selectedSession.id} />
                    </div>
                    {role === 'owner' && (
                      <div className="mt-3">
                        <button
                          type="button"
                          onClick={() => setDetailSessionId(selectedSession.id)}
                          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/10 px-3 text-[12px] font-medium text-primary transition-colors hover:bg-primary/15"
                        >
                          <Eye size={13} />
                          查看完整详情
                        </button>
                      </div>
                    )}
                  </div>

                  {msgLoading ? (
                    <div className="flex justify-center py-16">
                      <Loader2 size={16} className="animate-spin text-muted" />
                    </div>
                  ) : (
                    <MessageTimeline
                      messages={messages}
                      fullMessages={fullMessages}
                      searchText={debouncedSearchText}
                      emptyText={
                        debouncedSearchText
                          ? '当前会话无匹配消息'
                          : '当前会话暂无消息'
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
      {role === 'owner' && detailSessionId ? (
        <AdminSessionDetailModal
          sessionId={detailSessionId}
          onClose={() => setDetailSessionId('')}
        />
      ) : null}
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
