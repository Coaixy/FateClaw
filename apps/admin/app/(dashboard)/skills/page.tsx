'use client';

import { Suspense, useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  admin,
  AdminUser,
  AdminCustomSkill,
  AdminSkillGlobalConfig,
} from '@/lib/admin-api';
import { toAdminDocumentHref } from '@/lib/admin-navigation';
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
  BookOpen,
} from 'lucide-react';

function formatDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const VISIBILITY_LABELS: Record<AdminCustomSkill['visibility'], string> = {
  private: '私有',
  link_shared: '私密分享',
  shared: '公开上架',
};

function MetaPill({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'accent' | 'blue' | 'amber' | 'danger' | 'success';
}) {
  const toneClass = {
    neutral:
      'border-hairline bg-surface-card text-muted',
    accent:
      'border-primary/20 bg-primary/10 text-primary',
    blue: 'border-blue-500/25 bg-blue-500/10 text-blue-400',
    amber: 'border-amber-500/25 bg-amber-500/10 text-amber-400',
    danger: 'border-red-500/25 bg-red-500/10 text-red-400',
    success:
      'border-success/25 bg-success/10 text-success',
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
  skill: AdminCustomSkill;
  detailHref: string;
  onUpdateState: (
    id: string,
    data: {
      enabled?: boolean;
      visibility?: AdminCustomSkill['visibility'];
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
      visibility?: AdminCustomSkill['visibility'];
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
            <ChevronDown
              size={14}
              className="text-muted shrink-0 mt-0.5"
            />
          ) : (
            <ChevronRight
              size={14}
              className="text-muted shrink-0 mt-0.5"
            />
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
                <span>{skill.files.length} 个文件</span>
              </div>
              {skill.description ? (
                <div className="mt-1 text-[11px] text-muted line-clamp-2 break-words leading-relaxed">
                  {skill.description}
                </div>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-1.5">
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
                  <span>{skill.files.length} 个文件</span>
                </div>
              </div>

              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-wider text-muted">
                  状态
                </div>
                <div className="mt-1 flex flex-wrap gap-1.5">
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
          {/* Details grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {(
              [
                ['用户标识', skill.phone || '未绑定手机号'],
                ['状态', skill.enabled ? '已启用' : '未启用'],
                ['可见性', VISIBILITY_LABELS[skill.visibility]],
                ['内容长度', `${skill.content_length.toLocaleString()} 字`],
                ['文件数', String(skill.files.length)],
              ] as const
            ).map(([label, value]) => (
              <div
                key={label}
                className="px-2.5 py-2 rounded-md bg-canvas border border-hairline"
              >
                <div className="text-[10px] text-muted">
                  {label}
                </div>
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
                onClick={() =>
                  handleStateChange({
                    enabled: !skill.enabled,
                  })
                }
                className={`shrink-0 px-3 h-8 rounded-md border text-[12px] font-medium transition-colors disabled:opacity-50 cursor-pointer ${
                  skill.enabled
                    ? 'border-red-500/30 text-red-400 hover:bg-red-500/10'
                    : 'border-primary/30 text-primary hover:bg-primary/10'
                }`}
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
                ] as AdminCustomSkill['visibility'][]
              ).map((visibility) => {
                const active = skill.visibility === visibility;
                return (
                  <button
                    key={visibility}
                    type="button"
                    disabled={busy || active}
                    onClick={() =>
                      handleStateChange({
                        visibility,
                      })
                    }
                    className={`px-3 h-8 rounded-md border text-[12px] transition-colors disabled:opacity-50 cursor-pointer ${
                      active
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-hairline text-muted hover:text-ink hover:bg-surface-cream-strong'
                    }`}
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
              <div className="text-[12px] text-error">
                {actionError}
              </div>
            ) : null}
          </div>

          {/* Content preview */}
          <div>
            <div className="text-[11px] text-muted uppercase tracking-wider mb-1 flex items-center gap-1">
              <BookOpen size={11} /> Bundle 文件
            </div>
            <div className="space-y-2">
              {skill.files.map((file) => (
                <div
                  key={file.path}
                  className="rounded-md border border-hairline bg-canvas p-3"
                >
                  <div className="mb-2 text-[11px] font-medium text-muted">
                    {file.path}
                  </div>
                  <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-ink">
                    {file.content || '(空)'}
                  </pre>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
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
                <ToggleRight
                  size={22}
                  className="text-primary"
                />
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
  const [customSkills, setCustomSkills] = useState<AdminCustomSkill[]>([]);
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

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [u, s, g] = await Promise.all([
        admin.users({ page_size: 100 }),
        admin.customSkills({
          user_id: selectedUserId || undefined,
        }),
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
        visibility?: AdminCustomSkill['visibility'];
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
    loadData();
  }, [loadData]);

  const filtered = customSkills.filter((s) => {
    if (selectedVisibility === 'shared' && s.visibility !== 'shared')
      return false;
    if (selectedVisibility === 'link_shared' && s.visibility !== 'link_shared')
      return false;
    if (selectedVisibility === 'private' && s.visibility !== 'private')
      return false;
    return true;
  });

  const buildSkillDetailHref = useCallback(
    (skillId: string) => {
      const params = new URLSearchParams({ id: skillId });
      if (selectedUserId) params.set('user_id', selectedUserId);
      if (selectedVisibility) params.set('visibility', selectedVisibility);
      return `/skills/detail?${params.toString()}`;
    },
    [selectedUserId, selectedVisibility],
  );

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
          {/* 系统排盘全局配置 */}
          {globalConfigs.length > 0 && (
            <div className="mb-8">
              <div className="flex items-center gap-2 mb-3">
                <Shield
                  size={16}
                  className="text-muted shrink-0"
                />
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

          {/* Filters */}
          <div className="flex flex-col sm:flex-row gap-2 mb-4">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <Puzzle
                size={16}
                className="text-muted shrink-0"
              />
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

            <div className="flex items-center gap-2">
              <select
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
                <option value="">全部状态</option>
                <option value="link_shared">私密链接</option>
                <option value="shared">公开上架</option>
                <option value="private">私有</option>
              </select>
            </div>
          </div>

          {/* Skills list */}
          {filtered.length === 0 ? (
            <div className="text-center py-16">
              <Puzzle
                size={24}
                className="mx-auto mb-2 text-muted"
              />
              <p className="text-[13px] text-muted">
                暂无用户知识技能
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
