'use client';

import { Suspense, useEffect, useState, useCallback, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  admin,
  AdminUser,
  AdminCustomSkillSummary,
  AdminSkillGlobalConfig,
  AdminSkillComment,
} from '@/lib/admin-api';
import { toAdminDocumentHref } from '@/lib/admin-navigation';
import { SkillStorageBadge } from '@/components/skills/skill-storage-badge';
import {
  matchesSkillStorage,
  SKILL_STORAGE_META,
  shortRevision,
  type SkillStorageFilter,
} from '@/lib/skill-storage';
import {
  Loader2,
  Puzzle,
  Shield,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Share2,
  ToggleLeft,
  ToggleRight,
  Database,
  MessageSquare,
  Pin,
  ThumbsDown,
  ThumbsUp,
} from 'lucide-react';

function formatDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const VISIBILITY_LABELS: Record<AdminCustomSkillSummary['visibility'], string> =
  {
    private: '私有',
    link_shared: '私密分享',
    shared: '公开上架',
  };

/** 评论审核状态的中文展示标签。 */
const COMMENT_STATUS_LABELS: Record<AdminSkillComment['status'], string> = {
  pending: '待审核',
  approved: '已通过',
  rejected: '已拒绝',
};

function MetaPill({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'accent' | 'blue' | 'amber' | 'danger' | 'success';
}) {
  const toneClass = {
    neutral: 'border-hairline bg-surface-card text-muted',
    accent: 'border-primary/20 bg-primary/10 text-primary',
    blue: 'border-blue-500/25 bg-blue-500/10 text-blue-400',
    amber: 'border-amber-500/25 bg-amber-500/10 text-amber-400',
    danger: 'border-red-500/25 bg-red-500/10 text-red-400',
    success: 'border-success/25 bg-success/10 text-success',
  }[tone];

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium leading-5 ${toneClass}`}
    >
      {children}
    </span>
  );
}

function SkillRow({
  skill,
  detailHref,
  onUpdateState,
}: {
  skill: AdminCustomSkillSummary;
  detailHref: string;
  onUpdateState: (
    id: string,
    data: {
      enabled?: boolean;
      visibility?: AdminCustomSkillSummary['visibility'];
    },
  ) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const visibilityTone =
    skill.visibility === 'shared'
      ? 'amber'
      : skill.visibility === 'link_shared'
        ? 'blue'
        : 'neutral';

  const handleStateChange = useCallback(
    async (data: {
      enabled?: boolean;
      visibility?: AdminCustomSkillSummary['visibility'];
    }) => {
      setBusy(true);
      setActionError('');
      try {
        await onUpdateState(skill.id, data);
      } catch (err) {
        if (err instanceof Error) {
          setActionError(err.message);
        } else {
          throw err;
        }
      } finally {
        setBusy(false);
      }
    },
    [onUpdateState, skill.id],
  );

  return (
    <div className="border border-hairline rounded-lg overflow-hidden">
      <div className="flex items-stretch gap-2 px-1 py-1">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex-1 flex items-start gap-3 px-3 py-2.5 hover:bg-surface-cream-strong transition-colors cursor-pointer text-left rounded-md"
        >
          {expanded ? (
            <ChevronDown size={14} className="text-muted shrink-0 mt-0.5" />
          ) : (
            <ChevronRight size={14} className="text-muted shrink-0 mt-0.5" />
          )}
          <div className="flex-1 min-w-0">
            <div className="md:hidden min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <span className="block min-w-0 flex-1 text-[13px] font-medium truncate">
                  {skill.skill_name}
                </span>
                <span className="shrink-0 text-[11px] text-muted tabular-nums">
                  {skill.content_length.toLocaleString()} 字
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
                <span className="truncate max-w-[180px]">
                  {skill.phone || '未绑定手机号'}
                </span>
                <span className="text-hairline">•</span>
                <span>{skill.storage.file_count} 个文件</span>
              </div>
              {skill.description ? (
                <div className="mt-1 text-[11px] text-muted line-clamp-2 break-words leading-relaxed">
                  {skill.description}
                </div>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-1.5">
                <SkillStorageBadge storage={skill.storage} />
                <MetaPill tone={skill.enabled ? 'success' : 'danger'}>
                  {skill.enabled ? '启用中' : '已关闭'}
                </MetaPill>
                <MetaPill tone={visibilityTone}>
                  <Share2 size={10} />
                  {VISIBILITY_LABELS[skill.visibility]}
                </MetaPill>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted">
                <span>更 {formatDate(skill.updated_at)}</span>
                <span className="text-hairline">•</span>
                <span>建 {formatDate(skill.created_at)}</span>
                {skill.share_token ? (
                  <>
                    <span className="text-hairline">•</span>
                    <span>有分享令牌</span>
                  </>
                ) : null}
              </div>
            </div>
            <div className="hidden md:grid gap-3 md:grid-cols-[minmax(0,2.2fr)_minmax(160px,1fr)_minmax(220px,1.4fr)_130px] md:items-center">
              <div className="min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="block text-[13px] font-medium truncate">
                    {skill.skill_name}
                  </span>
                </div>
                <div className="mt-1 text-[12px] text-muted leading-relaxed">
                  {skill.description ? (
                    <span className="line-clamp-2 break-words">
                      {skill.description}
                    </span>
                  ) : (
                    <span className="text-muted/80">无描述</span>
                  )}
                </div>
              </div>

              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-wider text-muted">
                  归属
                </div>
                <div className="mt-1 text-[12px] font-medium text-ink truncate">
                  {skill.phone || '未绑定手机号'}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                  <span>{skill.storage.file_count} 个文件</span>
                </div>
              </div>

              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-wider text-muted">
                  状态
                </div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <SkillStorageBadge storage={skill.storage} />
                  <MetaPill tone={skill.enabled ? 'success' : 'danger'}>
                    {skill.enabled ? '启用中' : '已关闭'}
                  </MetaPill>
                  <MetaPill tone={visibilityTone}>
                    <Share2 size={10} />
                    {VISIBILITY_LABELS[skill.visibility]}
                  </MetaPill>
                  {skill.share_token ? (
                    <MetaPill tone="neutral">有分享令牌</MetaPill>
                  ) : null}
                </div>
              </div>

              <div className="min-w-0 md:text-right">
                <div className="text-[10px] uppercase tracking-wider text-muted">
                  统计
                </div>
                <div className="mt-1 text-[12px] font-medium text-ink tabular-nums">
                  {skill.content_length.toLocaleString()} 字
                </div>
                <div className="mt-1 text-[11px] text-muted leading-relaxed">
                  <div className="font-mono">
                    {shortRevision(skill.storage.current_revision_id)}
                  </div>
                  <div>更 {formatDate(skill.updated_at)}</div>
                  <div>建 {formatDate(skill.created_at)}</div>
                </div>
              </div>
            </div>
          </div>
        </button>

        <div className="flex shrink-0 items-start justify-center pt-2 pr-2">
          <a
            href={toAdminDocumentHref(detailHref)}
            className="inline-flex h-8 items-center rounded-md border border-hairline bg-surface-card px-3 text-[12px] text-muted hover:text-ink hover:bg-surface-cream-strong transition-colors"
          >
            详情
          </a>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-hairline px-4 py-4 space-y-3 bg-surface-card">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {(
              [
                ['用户标识', skill.phone || '未绑定手机号'],
                ['状态', skill.enabled ? '已启用' : '未启用'],
                ['可见性', VISIBILITY_LABELS[skill.visibility]],
                ['内容长度', `${skill.content_length.toLocaleString()} 字`],
                ['文件数', String(skill.storage.file_count)],
                ['修订记录', `${skill.storage.revision_count} 次保存`],
              ] as const
            ).map(([label, value]) => (
              <div
                key={label}
                className="px-2.5 py-2 rounded-md bg-canvas border border-hairline"
              >
                <div className="text-[10px] text-muted">{label}</div>
                <div className="text-[13px] font-medium mt-0.5 truncate">
                  {value}
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-lg border border-hairline bg-canvas p-3 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] text-muted uppercase tracking-wider">
                  管理操作
                </div>
                <div className="text-[12px] text-muted mt-0.5">
                  管理员可直接关闭技能或修改分享状态
                </div>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => handleStateChange({ enabled: !skill.enabled })}
                className={`shrink-0 px-3 h-8 rounded-md border text-[12px] font-medium transition-colors disabled:opacity-50 cursor-pointer ${skill.enabled ? 'border-red-500/30 text-red-400 hover:bg-red-500/10' : 'border-primary/30 text-primary hover:bg-primary/10'}`}
              >
                {skill.enabled ? '关闭技能' : '启用技能'}
              </button>
            </div>

            <div className="flex flex-wrap gap-2">
              {(
                [
                  'private',
                  'link_shared',
                  'shared',
                ] as AdminCustomSkillSummary['visibility'][]
              ).map((visibility) => {
                const active = skill.visibility === visibility;
                return (
                  <button
                    key={visibility}
                    type="button"
                    disabled={busy || active}
                    onClick={() => handleStateChange({ visibility })}
                    className={`px-3 h-8 rounded-md border text-[12px] transition-colors disabled:opacity-50 cursor-pointer ${active ? 'border-primary bg-primary/10 text-primary' : 'border-hairline text-muted hover:text-ink hover:bg-surface-cream-strong'}`}
                  >
                    {VISIBILITY_LABELS[visibility]}
                  </button>
                );
              })}
            </div>

            {skill.share_token ? (
              <div className="text-[11px] text-muted">
                分享令牌：
                <span className="font-mono break-all ml-1 text-ink">
                  {skill.share_token}
                </span>
              </div>
            ) : null}

            {actionError ? (
              <div className="text-[12px] text-error">{actionError}</div>
            ) : null}
          </div>

          <div className="rounded-lg border border-hairline bg-canvas p-3">
            <div className="flex items-center gap-2 text-[12px] font-medium">
              <Database size={13} />
              数据库内容
            </div>
            <p className="mt-2 text-[12px] leading-relaxed text-muted">
              {SKILL_STORAGE_META[skill.storage.state].description}
            </p>
            {skill.storage.current_revision_id ? (
              <p className="mt-2 break-all font-mono text-[11px] text-muted">
                当前修订：{skill.storage.current_revision_id}
              </p>
            ) : null}
            <a
              href={toAdminDocumentHref(detailHref)}
              className="mt-3 inline-flex text-[12px] font-medium text-primary hover:underline"
            >
              查看修订记录与文件内容 →
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

function CommentReviewPanel() {
  const [status, setStatus] = useState<'pending' | 'approved' | 'rejected' | ''>('pending');
  const [comments, setComments] = useState<AdminSkillComment[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');

  const loadComments = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await admin.skillComments({
        status: status || undefined,
        limit: 100,
      });
      setComments(res.items);
    } catch (err) {
      setComments([]);
      setError(err instanceof Error ? err.message : '加载评论失败');
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void loadComments();
  }, [loadComments]);

  const updateOne = useCallback(
    async (id: string, op: () => Promise<unknown>) => {
      setBusyId(id);
      setError('');
      try {
        const updated = (await op()) as AdminSkillComment;
        // 以服务端返回的最新状态为准更新本地列表。
        // 当存在状态过滤时（如“待审核”），若评论状态已不再匹配过滤条件，
        // 应将其移出当前列表，避免审核后仍停留在原列表造成困惑；
        // 置顶操作不改变状态，状态必然仍匹配，自然走原地替换。
        setComments((prev) =>
          status && updated.status !== status
            ? prev.filter((item) => item.id !== id)
            : prev.map((item) => (item.id === id ? updated : item)),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : '操作失败');
      } finally {
        setBusyId('');
      }
    },
    [status],
  );

  return (
    <section className="rounded-xl border border-hairline bg-surface-card p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-[14px] font-semibold flex items-center gap-1.5"><MessageSquare size={14} className="text-muted" /> 评论审核</h2>
          <p className="mt-1 text-[12px] text-muted">匿名展示前由管理员审核和置顶。</p>
        </div>
        <div className="flex items-center gap-2">
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="h-8 rounded-md border border-hairline bg-canvas px-2 text-[12px]">
            <option value="pending">待审核</option>
            <option value="approved">已通过</option>
            <option value="rejected">已拒绝</option>
            <option value="">全部</option>
          </select>
          <button type="button" onClick={() => void loadComments()} className="inline-flex h-8 items-center gap-1 rounded-md border border-hairline px-3 text-[12px] text-muted hover:text-ink hover:bg-surface-cream-strong transition-colors">
            <RefreshCw size={13} /> 刷新
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-10"><Loader2 size={18} className="animate-spin text-muted" /></div>
      ) : error ? (
        <div className="mt-4 text-[12px] text-error">{error}</div>
      ) : comments.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-hairline bg-canvas px-4 py-8 text-center text-[13px] text-muted">暂无评论</div>
      ) : (
        <div className="mt-4 space-y-2">
          {comments.map((comment) => (
            <article key={comment.id} className="rounded-lg border border-hairline bg-canvas p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                  <span>{comment.skill_name}</span>
                  <span className="text-hairline">•</span>
                  <span>{comment.user_phone || comment.user_id}</span>
                  <MetaPill tone={comment.status === 'approved' ? 'success' : comment.status === 'rejected' ? 'danger' : 'amber'}>{COMMENT_STATUS_LABELS[comment.status]}</MetaPill>
                  {comment.pinned ? <MetaPill tone="accent"><Pin size={10} />置顶</MetaPill> : null}
                </div>
                <div className="text-[10px] text-muted">{formatDate(comment.created_at)}</div>
              </div>
              <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-6 text-ink">{comment.body}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {comment.status !== 'approved' ? (
                  <button type="button" disabled={busyId === comment.id} onClick={() => void updateOne(comment.id, () => admin.reviewSkillComment(comment.id, 'approved'))} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline px-3 text-[12px] text-muted hover:text-ink hover:bg-surface-cream-strong transition-colors disabled:opacity-50">
                    <ThumbsUp size={12} /> 通过
                  </button>
                ) : null}
                {comment.status !== 'rejected' ? (
                  <button type="button" disabled={busyId === comment.id} onClick={() => void updateOne(comment.id, () => admin.reviewSkillComment(comment.id, 'rejected'))} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline px-3 text-[12px] text-muted hover:text-ink hover:bg-surface-cream-strong transition-colors disabled:opacity-50">
                    <ThumbsDown size={12} /> 拒绝
                  </button>
                ) : null}
                {comment.status === 'approved' ? (
                  <button type="button" disabled={busyId === comment.id} onClick={() => void updateOne(comment.id, () => admin.pinSkillComment(comment.id, !comment.pinned))} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline px-3 text-[12px] text-muted hover:text-ink hover:bg-surface-cream-strong transition-colors disabled:opacity-50">
                    <Pin size={12} /> {comment.pinned ? '取消置顶' : '置顶'}
                  </button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function GlobalSkillRow({
  config,
  onToggleGlobal,
}: {
  config: AdminSkillGlobalConfig;
  onToggleGlobal: (name: string, enabled: boolean) => void;
}) {
  return (
    <div className="border border-hairline rounded-lg overflow-hidden">
      <div className="w-full flex items-center gap-3 px-4 py-3 text-left">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[13px] font-medium">{config.skill_name}</span>
          </div>
          {config.dir && (
            <div className="text-[12px] text-muted mt-0.5 truncate">
              {config.dir}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <label className="flex items-center gap-1.5 cursor-pointer text-[12px] text-muted">
            <span>全局</span>
            <button
              type="button"
              onClick={() => onToggleGlobal(config.skill_name, !config.globally_enabled)}
              className="cursor-pointer"
            >
              {config.globally_enabled ? (
                <ToggleRight size={22} className="text-primary" />
              ) : (
                <ToggleLeft size={22} className="text-muted" />
              )}
            </button>
          </label>
        </div>
      </div>
    </div>
  );
}

function AdminSkillsContent() {
  const searchParams = useSearchParams();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [customSkills, setCustomSkills] = useState<AdminCustomSkillSummary[]>(
    [],
  );
  const [globalConfigs, setGlobalConfigs] = useState<AdminSkillGlobalConfig[]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [selectedUserId, setSelectedUserId] = useState(
    searchParams.get('user_id') || '',
  );
  const [selectedVisibility, setSelectedVisibility] = useState(
    searchParams.get('visibility') || '',
  );
  const [selectedStorage, setSelectedStorage] = useState<SkillStorageFilter>(
    (['stored', 'pending', 'attention'].includes(
      searchParams.get('storage') || '',
    )
      ? searchParams.get('storage')
      : '') as SkillStorageFilter,
  );

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [u, s, g] = await Promise.all([
        admin.users({ page_size: 100 }),
        admin.customSkills({ user_id: selectedUserId || undefined }),
        admin.globalSkills(),
      ]);
      setUsers(u.items);
      setCustomSkills(s);
      setGlobalConfigs(g);
    } catch (err) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        throw err;
      }
    } finally {
      setLoading(false);
    }
  }, [selectedUserId]);

  const handleToggleGlobal = async (name: string, enabled: boolean) => {
    try {
      await admin.setSkillGlobalEnabled(name, enabled);
      setGlobalConfigs((prev) =>
        prev.map((c) =>
          c.skill_name === name ? { ...c, globally_enabled: enabled } : c,
        ),
      );
    } catch (err) {
      if (err instanceof Error) return;
      throw err;
    }
  };

  const handleUpdateCustomSkillState = useCallback(
    async (
      id: string,
      data: {
        enabled?: boolean;
        visibility?: AdminCustomSkillSummary['visibility'];
      },
    ) => {
      const updated = await admin.updateCustomSkillState(id, data);
      setCustomSkills((prev) =>
        prev.map((skill) => (skill.id === id ? updated : skill)),
      );
    },
    [],
  );

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const filtered = useMemo(
    () =>
      customSkills.filter((s) => {
        if (selectedVisibility === 'shared' && s.visibility !== 'shared')
          return false;
        if (
          selectedVisibility === 'link_shared' &&
          s.visibility !== 'link_shared'
        )
          return false;
        if (selectedVisibility === 'private' && s.visibility !== 'private')
          return false;
        return matchesSkillStorage(s.storage, selectedStorage);
      }),
    [customSkills, selectedVisibility, selectedStorage],
  );

  const buildSkillDetailHref = useCallback(
    (skillId: string) => {
      const params = new URLSearchParams({ id: skillId });
      if (selectedUserId) params.set('user_id', selectedUserId);
      if (selectedVisibility) params.set('visibility', selectedVisibility);
      if (selectedStorage) params.set('storage', selectedStorage);
      return `/skills/detail?${params.toString()}`;
    },
    [selectedUserId, selectedVisibility, selectedStorage],
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
          {globalConfigs.length > 0 && (
            <div className="mb-8">
              <div className="flex items-center gap-2 mb-3">
                <Shield size={16} className="text-muted shrink-0" />
                <h2 className="text-lg font-semibold shrink-0">系统排盘配置</h2>
                <span className="text-[12px] text-muted shrink-0">
                  ({globalConfigs.length})
                </span>
              </div>
              <p className="text-[12px] text-muted mb-3">
                全局控制排盘是否可用，用户侧不再单独覆盖。
              </p>
              <div className="space-y-2">
                {globalConfigs.map((config) => (
                  <GlobalSkillRow
                    key={config.skill_name}
                    config={config}
                    onToggleGlobal={handleToggleGlobal}
                  />
                ))}
              </div>
            </div>
          )}

          <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              {
                label: '技能总数',
                value: customSkills.length,
                filter: '' as SkillStorageFilter,
              },
              {
                label: '已入库',
                value: customSkills.filter(
                  (skill) => skill.storage.state === 'stored',
                ).length,
                filter: 'stored' as SkillStorageFilter,
              },
              {
                label: '待迁移',
                value: customSkills.filter(
                  (skill) => skill.storage.state === 'pending',
                ).length,
                filter: 'pending' as SkillStorageFilter,
              },
              {
                label: '需处理',
                value: customSkills.filter((skill) =>
                  matchesSkillStorage(skill.storage, 'attention'),
                ).length,
                filter: 'attention' as SkillStorageFilter,
              },
            ].map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={() => setSelectedStorage(item.filter)}
                aria-pressed={selectedStorage === item.filter}
                className={`rounded-xl border bg-surface-card px-4 py-3 text-left transition-colors hover:bg-surface-cream-strong ${selectedStorage === item.filter ? 'border-primary/60' : 'border-hairline'}`}
              >
                <span className="text-[12px] text-muted">{item.label}</span>
                <span className="mt-1 block text-2xl font-semibold tabular-nums">
                  {item.value.toLocaleString()}
                </span>
              </button>
            ))}
          </div>
          <p className="mb-4 text-[12px] leading-relaxed text-muted">
            统计对应当前用户范围。已入库表示数据库持有完整正文，运行时会按需恢复本地缓存。
          </p>

          <div className="flex flex-col sm:flex-row gap-2 mb-4">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <Puzzle size={16} className="text-muted shrink-0" />
              <h2 className="text-lg font-semibold shrink-0">用户知识技能</h2>
              <span className="text-[12px] text-muted shrink-0">
                ({filtered.length})
              </span>
              <button
                onClick={loadData}
                className="p-1.5 rounded-md text-muted hover:text-ink transition-colors cursor-pointer"
                title="刷新"
              >
                <RefreshCw size={13} />
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="筛选存储状态"
                value={selectedStorage}
                onChange={(event) =>
                  setSelectedStorage(event.target.value as SkillStorageFilter)
                }
                className="h-8 px-2 rounded-md border border-hairline bg-canvas text-[13px] focus:outline-none cursor-pointer"
              >
                <option value="">全部存储状态</option>
                <option value="stored">已入库</option>
                <option value="pending">待迁移</option>
                <option value="attention">需处理</option>
              </select>
              <select
                aria-label="筛选技能用户"
                value={selectedUserId}
                onChange={(e) => setSelectedUserId(e.target.value)}
                className="h-8 px-2 rounded-md border border-hairline bg-canvas text-[13px] focus:outline-none cursor-pointer max-w-[180px]"
              >
                <option value="">全部用户</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.phone}
                  </option>
                ))}
              </select>

              <select
                value={selectedVisibility}
                onChange={(e) => setSelectedVisibility(e.target.value)}
                className="h-8 px-2 rounded-md border border-hairline bg-canvas text-[13px] focus:outline-none cursor-pointer"
              >
                <option value="">全部可见性</option>
                <option value="link_shared">私密链接</option>
                <option value="shared">公开上架</option>
                <option value="private">私有</option>
              </select>
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="text-center py-16">
              <Puzzle size={24} className="mx-auto mb-2 text-muted" />
              <p className="text-[13px] text-muted">
                {customSkills.length
                  ? '当前筛选下没有技能'
                  : '暂无用户知识技能'}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {filtered.map((skill) => (
                <SkillRow
                  key={skill.id}
                  skill={skill}
                  detailHref={buildSkillDetailHref(skill.id)}
                  onUpdateState={handleUpdateCustomSkillState}
                />
              ))}
            </div>
          )}

          <div className="mt-8">
            <CommentReviewPanel />
          </div>
        </>
      )}
    </>
  );
}

export default function AdminSkillsPage() {
  return (
    <Suspense>
      <AdminSkillsContent />
    </Suspense>
  );
}
