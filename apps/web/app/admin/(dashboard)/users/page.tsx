'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  admin,
  type AdminUser,
  type UserDetail,
  type WalletTransaction,
} from '@/lib/admin-api';
import { toAdminDocumentHref } from '@/lib/admin-navigation';
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Clock,
  Coins,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Smartphone,
  Trash2,
  UserRound,
  Users,
  WalletCards,
} from 'lucide-react';

// ─── 辅助函数 ───

function fmt(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

function fmtPoints(points: number) {
  return `${points.toLocaleString()} 积分`;
}

function formatDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function shortDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
  });
}

function displayUser(user: AdminUser) {
  return user.phone;
}

function totalTokens(user: AdminUser) {
  return user.usage.total_input_tokens + user.usage.total_output_tokens;
}

const USER_ROLE_OPTIONS: Array<{ value: AdminUser['role']; label: string }> = [
  { value: 'consumer', label: '消费者' },
  { value: 'creator', label: '创作者' },
  { value: 'both', label: '消费者 + 创作者' },
  { value: 'admin', label: '管理员' },
];

// ─── 小组件 ───

function SummaryCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: typeof Users;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="rounded-xl border border-hairline bg-surface-card px-4 py-3">
      <div className="mb-2 flex items-center gap-2 text-[12px] text-muted">
        <Icon size={13} />
        <span>{label}</span>
      </div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 text-[11px] text-muted">{sub}</div>
    </div>
  );
}

function DataCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-muted">
        {label}
      </div>
      <div className="mt-0.5 truncate text-[13px] font-medium tabular-nums">
        {value}
      </div>
    </div>
  );
}

function WalletMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface-card px-3 py-2.5">
      <div className="text-[11px] text-muted">{label}</div>
      <div className="mt-1 text-[15px] font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function UsageMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] text-muted">{label}</div>
      <div className="mt-0.5 text-[13px] font-medium tabular-nums">{value}</div>
    </div>
  );
}

function CreateUserPanel({
  onCreated,
}: {
  onCreated: () => void | Promise<void>;
}) {
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<AdminUser['role']>('consumer');
  const [phoneVerified, setPhoneVerified] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState('');

  const handleSubmit = async () => {
    setMessage('');
    const normalizedPhone = phone.trim();
    if (!normalizedPhone) {
      setMessage('请输入手机号');
      return;
    }
    if (password.length < 8) {
      setMessage('密码至少 8 位');
      return;
    }

    setSubmitting(true);
    try {
      await admin.createUser({
        phone: normalizedPhone,
        password,
        role,
        phone_verified: phoneVerified,
      });
      setPhone('');
      setPassword('');
      setRole('consumer');
      setPhoneVerified(true);
      setMessage('用户已创建');
      await onCreated();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '创建用户失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="mb-4 rounded-xl border border-hairline bg-surface-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <Plus size={14} className="text-muted" />
        <h3 className="text-[14px] font-semibold">添加用户</h3>
      </div>

      <div className="grid gap-3 lg:grid-cols-[180px_180px_180px_auto_auto] lg:items-end">
        <label className="min-w-0">
          <span className="mb-1 block text-[12px] text-muted">手机号</span>
          <input
            type="tel"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            placeholder="13800138000"
            className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-hairline"
          />
        </label>

        <label className="min-w-0">
          <span className="mb-1 block text-[12px] text-muted">初始密码</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="至少 8 位"
            className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-hairline"
          />
        </label>

        <label className="min-w-0">
          <span className="mb-1 block text-[12px] text-muted">角色</span>
          <select
            value={role}
            onChange={(event) =>
              setRole(event.target.value as AdminUser['role'])
            }
            className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-hairline"
          >
            {USER_ROLE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="inline-flex h-9 cursor-pointer items-center gap-2 text-[13px] text-muted">
          <input
            type="checkbox"
            checked={phoneVerified}
            onChange={(event) => setPhoneVerified(event.target.checked)}
            className="h-4 w-4 accent-primary"
          />
          手机号已验证
        </label>

        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={submitting}
          className="inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-md bg-primary px-4 text-[13px] font-medium text-on-primary transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Plus size={12} />
          )}
          添加用户
        </button>
      </div>

      {message && (
        <div className="mt-3 rounded-lg border border-hairline bg-canvas px-3 py-2 text-[12px] text-muted">
          {message}
        </div>
      )}
    </section>
  );
}

// ─── 用户行 ───

function UserRow({
  user,
  onRefresh,
}: {
  user: AdminUser;
  onRefresh: () => void | Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [adjustingBalance, setAdjustingBalance] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [msg, setMsg] = useState('');
  const [balanceDelta, setBalanceDelta] = useState('');
  const [balanceNote, setBalanceNote] = useState('');
  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);

  const loadDetail = useCallback(async () => {
    setLoading(true);
    setMsg('');
    try {
      const [d, tx] = await Promise.all([
        admin.userDetail(user.id),
        admin.userTransactions(user.id),
      ]);
      setDetail(d);
      setTransactions(tx);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '加载用户详情失败');
    } finally {
      setLoading(false);
    }
  }, [user.id]);

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !detail) void loadDetail();
  };

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setDeleting(true);
    try {
      await admin.deleteUser(user.id);
      void onRefresh();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '删除失败');
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const handleAdjustBalance = async () => {
    const amount = parseInt(balanceDelta, 10);
    if (!amount) {
      setMsg('请输入有效的调整积分数量');
      return;
    }
    setAdjustingBalance(true);
    setMsg('');
    try {
      await admin.adjustPurchasedPoints(user.id, {
        amount_points: amount,
        note: balanceNote || undefined,
      });
      setBalanceDelta('');
      setBalanceNote('');
      setMsg('积分已更新');
      void onRefresh();
      void loadDetail();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '积分调整失败');
    } finally {
      setAdjustingBalance(false);
    }
  };

  const meaningfulTransactions = transactions
    .filter((tx) => tx.amount_points !== 0)
    .slice(0, 8);

  return (
    <div className="overflow-hidden rounded-xl border border-hairline bg-surface-card">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        className="grid w-full cursor-pointer gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-cream-strong md:grid-cols-[minmax(0,1.25fr)_110px_130px_120px_28px] md:items-center"
      >
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-canvas text-muted">
            <UserRound size={16} />
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="truncate text-sm font-semibold">
                {displayUser(user)}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
              <span>注册 {shortDate(user.created_at)}</span>
              <span>ID {user.id.slice(0, 8)}</span>
              <span className="md:hidden">{user.account_count} 个账号</span>
              <span className="md:hidden">
                可用 {fmtPoints(user.available_points)}
              </span>
            </div>
          </div>
        </div>

        <DataCell label="账号" value={`${user.account_count} 个`} />
        <DataCell label="可用积分" value={fmtPoints(user.available_points)} />
        <DataCell label="总 Token" value={fmt(totalTokens(user))} />

        <div className="hidden justify-end md:flex">
          {expanded ? (
            <ChevronDown size={15} className="text-muted" />
          ) : (
            <ChevronRight size={15} className="text-muted" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-hairline bg-canvas/35 px-4 py-4">
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2
                size={16}
                className="animate-spin text-muted"
              />
            </div>
          ) : detail ? (
            <div className="space-y-5">
              {msg && (
                <div className="rounded-lg border border-hairline bg-surface-card px-3 py-2 text-[12px] text-muted">
                  {msg}
                </div>
              )}

              <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
                <div className="space-y-5">
                  <section className="border-b border-hairline pb-4">
                    <div className="grid gap-2 text-[12px] text-muted sm:grid-cols-2">
                      <span>本月 Token {fmt(user.monthly_tokens_used)}</span>
                      <span>
                        官方模型扣费{' '}
                        {fmtPoints(user.estimated_monthly_total_points)}
                      </span>
                    </div>
                  </section>

                  <section className="border-b border-hairline pb-4">
                    <div className="mb-3 flex items-center gap-2">
                      <WalletCards
                        size={14}
                        className="text-muted"
                      />
                      <h4 className="text-[13px] font-semibold">积分余额</h4>
                    </div>
                    <div className="mb-3 grid overflow-hidden rounded-lg border border-hairline bg-hairline [gap:1px] sm:grid-cols-4">
                      <WalletMetric
                        label="充值"
                        value={detail.user.purchased_points.toLocaleString()}
                      />
                      <WalletMetric
                        label="赠送"
                        value={detail.user.bonus_points.toLocaleString()}
                      />
                      <WalletMetric
                        label="冻结"
                        value={detail.user.reserved_points.toLocaleString()}
                      />
                      <WalletMetric
                        label="可用"
                        value={detail.user.available_points.toLocaleString()}
                      />
                    </div>

                    <div className="grid gap-2 lg:grid-cols-[180px_minmax(0,1fr)_auto] lg:items-end">
                      <label className="min-w-0">
                        <span className="mb-1 block text-[12px] text-muted">
                          调整积分数量
                        </span>
                        <input
                          type="number"
                          value={balanceDelta}
                          onChange={(e) => setBalanceDelta(e.target.value)}
                          placeholder="正数增加，负数扣减"
                          className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-hairline"
                        />
                      </label>
                      <label className="min-w-0">
                        <span className="mb-1 block text-[12px] text-muted">
                          备注
                        </span>
                        <input
                          type="text"
                          value={balanceNote}
                          onChange={(e) => setBalanceNote(e.target.value)}
                          placeholder="例如：人工充值 10000 积分"
                          className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-hairline"
                        />
                      </label>
                      <button
                        type="button"
                        onClick={handleAdjustBalance}
                        disabled={adjustingBalance}
                        className="inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-md bg-primary px-4 text-[13px] font-medium text-on-primary transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {adjustingBalance && (
                          <Loader2 size={12} className="animate-spin" />
                        )}
                        调整积分
                      </button>
                    </div>
                  </section>

                  <section className="border-b border-hairline pb-4">
                    <div className="mb-3 flex items-center gap-2">
                      <Activity
                        size={14}
                        className="text-muted"
                      />
                      <h4 className="text-[13px] font-semibold">用量统计</h4>
                    </div>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                      <UsageMetric
                        label="总消息"
                        value={fmt(detail.usage.total_messages)}
                      />
                      <UsageMetric
                        label="今日消息"
                        value={fmt(detail.usage.today_messages)}
                      />
                      <UsageMetric
                        label="总输入"
                        value={fmt(detail.usage.total_input_tokens)}
                      />
                      <UsageMetric
                        label="总输出"
                        value={fmt(detail.usage.total_output_tokens)}
                      />
                      <UsageMetric
                        label="今日输入"
                        value={fmt(detail.usage.today_input_tokens)}
                      />
                      <UsageMetric
                        label="今日输出"
                        value={fmt(detail.usage.today_output_tokens)}
                      />
                    </div>
                  </section>

                  <section>
                    <div className="mb-2 flex items-center gap-2">
                      <Coins size={14} className="text-muted" />
                      <h4 className="text-[13px] font-semibold">最近流水</h4>
                    </div>
                    {meaningfulTransactions.length > 0 ? (
                      <div className="divide-y divide-hairline">
                        {meaningfulTransactions.map((tx) => (
                          <div
                            key={tx.id}
                            className="grid gap-2 py-2 text-[12px] sm:grid-cols-[minmax(0,1fr)_120px]"
                          >
                            <div className="min-w-0">
                              <div className="truncate font-medium">
                                {tx.note || tx.kind}
                              </div>
                              <div className="mt-0.5 text-[11px] text-muted">
                                {formatDate(tx.created_at)}
                              </div>
                            </div>
                            <div
                              className={`font-mono tabular-nums sm:text-right ${
                                tx.amount_points > 0
                                  ? 'text-success'
                                  : 'text-error'
                              }`}
                            >
                              {tx.amount_points > 0 ? '+' : ''}
                              {tx.amount_points.toLocaleString()} 积分
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-[13px] text-muted">
                        暂无可展示流水
                      </p>
                    )}
                  </section>
                </div>

                <aside className="space-y-5 xl:border-l xl:border-hairline xl:pl-5">
                  <section className="border-b border-hairline pb-4">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <Smartphone
                          size={14}
                          className="text-muted"
                        />
                        <h4 className="text-[13px] font-semibold">绑定账号</h4>
                      </div>
                      <span className="text-[12px] text-muted">
                        {detail.accounts.length} 个
                      </span>
                    </div>
                    {detail.accounts.length === 0 ? (
                      <p className="text-[13px] text-muted">
                        无绑定账号
                      </p>
                    ) : (
                      <div className="divide-y divide-hairline">
                        {detail.accounts.map((acc) => (
                          <div
                            key={acc.id}
                            className="flex items-center justify-between gap-3 py-2 text-[13px]"
                          >
                            <span className="min-w-0 truncate">
                              {acc.name || acc.id}
                            </span>
                            <span
                              className={`shrink-0 text-[11px] ${
                                acc.enabled
                                  ? 'text-success'
                                  : 'text-muted'
                              }`}
                            >
                              {acc.enabled ? '启用' : '停用'}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {detail.active_tasks > 0 && (
                      <p className="mt-2 text-[12px] text-muted">
                        活跃任务 {detail.active_tasks} 个
                      </p>
                    )}
                  </section>

                  <section className="border-b border-hairline pb-4">
                    <div className="mb-3 flex items-center gap-2">
                      <ShieldCheck
                        size={14}
                        className="text-muted"
                      />
                      <h4 className="text-[13px] font-semibold">快捷查看</h4>
                    </div>
                    <div className="grid gap-2">
                      <a
                        href={toAdminDocumentHref(
                          `/admin/messages?user_id=${encodeURIComponent(user.id)}`,
                        )}
                        className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-hairline text-[12px] text-muted transition-colors hover:border-hairline hover:text-ink"
                      >
                        <MessageSquare size={12} />
                        查看消息
                      </a>
                      <a
                        href={toAdminDocumentHref(
                          `/admin/tasks?user_id=${encodeURIComponent(user.id)}`,
                        )}
                        className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-hairline text-[12px] text-muted transition-colors hover:border-hairline hover:text-ink"
                      >
                        <Clock size={12} />
                        查看任务
                      </a>
                    </div>
                  </section>

                  <section>
                    <div className="mb-3 flex items-center gap-2">
                      <AlertTriangle
                        size={14}
                        className="text-error"
                      />
                      <h4 className="text-[13px] font-semibold text-error">
                        危险操作
                      </h4>
                    </div>
                    <button
                      type="button"
                      onClick={handleDelete}
                      disabled={deleting}
                      className={`inline-flex h-9 w-full cursor-pointer items-center justify-center gap-1.5 rounded-md text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                        confirmDelete
                          ? 'bg-error text-white'
                          : 'border border-error text-error hover:bg-error hover:text-white'
                      }`}
                    >
                      {deleting ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Trash2 size={12} />
                      )}
                      {confirmDelete ? '确认删除该用户及所有数据' : '删除用户'}
                    </button>
                    {confirmDelete && !deleting && (
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(false)}
                        className="mt-2 cursor-pointer text-[12px] text-muted hover:text-ink"
                      >
                        取消
                      </button>
                    )}
                  </section>
                </aside>
              </div>
            </div>
          ) : (
            <div className="py-6 text-center text-[13px] text-muted">
              用户详情加载失败
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── 页面 ───

export default function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');

  const fetchUsers = useCallback(async () => {
    setRefreshing(true);
    setError('');
    try {
      setUsers(await admin.users());
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchUsers();
  }, [fetchUsers]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return users;
    return users.filter(
      (u) => u.phone.includes(query) || u.id.toLowerCase().includes(query),
    );
  }, [search, users]);

  const summary = useMemo(() => {
    const totalAccounts = users.reduce((sum, u) => sum + u.account_count, 0);
    const totalAvailablePoints = users.reduce(
      (sum, u) => sum + u.available_points,
      0,
    );
    const todayMessages = users.reduce(
      (sum, u) => sum + u.usage.today_messages,
      0,
    );

    return {
      totalAccounts,
      totalAvailablePoints,
      todayMessages,
      chargedPoints: users.reduce(
        (sum, u) => sum + u.estimated_monthly_total_points,
        0,
      ),
    };
  }, [users]);

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 size={20} className="animate-spin text-muted" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-20 text-center">
        <p className="text-[13px] text-error">{error}</p>
        <button
          type="button"
          onClick={fetchUsers}
          className="mt-2 cursor-pointer text-[13px] text-muted hover:text-ink"
        >
          重试
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Users size={16} className="text-muted" />
            <h2 className="text-lg font-semibold">用户管理</h2>
            <span className="text-[12px] text-muted">
              {filtered.length} / {users.length}
            </span>
            <button
              type="button"
              onClick={fetchUsers}
              disabled={refreshing}
              className="cursor-pointer rounded-md p-1.5 text-muted transition-colors hover:text-ink disabled:opacity-50"
              title="刷新"
            >
              <RefreshCw
                size={13}
                className={refreshing ? 'animate-spin' : ''}
              />
            </button>
          </div>
          <p className="mt-1 text-[12px] text-muted">
            管理积分余额、绑定账号和用户级操作
          </p>
        </div>

        <div className="relative w-full lg:w-80">
          <Search
            size={13}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索手机号或 ID"
            className="h-9 w-full rounded-md border border-hairline bg-canvas pl-8 pr-3 text-[13px] outline-none transition-colors placeholder:text-muted focus:border-hairline"
          />
        </div>
      </div>

      <CreateUserPanel onCreated={fetchUsers} />

      <div className="mb-4 grid grid-cols-2 gap-2 xl:grid-cols-4">
        <SummaryCard
          icon={Users}
          label="用户"
          value={fmt(users.length)}
          sub={`当前显示 ${fmt(filtered.length)}`}
        />
        <SummaryCard
          icon={Coins}
          label="官方扣费"
          value={fmt(summary.chargedPoints)}
          sub="本月官方模型积分"
        />
        <SummaryCard
          icon={Smartphone}
          label="绑定账号"
          value={fmt(summary.totalAccounts)}
          sub="全部用户账号数"
        />
        <SummaryCard
          icon={WalletCards}
          label="可用积分"
          value={fmt(summary.totalAvailablePoints)}
          sub={`今日消息 ${fmt(summary.todayMessages)}`}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-hairline bg-surface-card py-12 text-center">
          <p className="text-[13px] text-muted">
            {search ? '无匹配用户' : '暂无用户'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((user) => (
            <UserRow key={user.id} user={user} onRefresh={fetchUsers} />
          ))}
        </div>
      )}
    </>
  );
}
