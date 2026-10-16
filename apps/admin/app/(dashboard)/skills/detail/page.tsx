'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { admin, AdminApiError, AdminCustomSkill } from '@/lib/admin-api';
import { toAdminDocumentHref } from '@/lib/admin-navigation';
import { SkillStorageBadge } from '@/components/skills/skill-storage-badge';
import { SkillFileBrowser } from '@/components/skills/skill-file-browser';
import {
  formatSkillDate as formatDate,
  shortRevision,
  SKILL_STORAGE_META,
} from '@/lib/skill-storage';
import {
  ArrowLeft,
  Calendar,
  Clock3,
  Database,
  History,
  Loader2,
  RefreshCw,
  Share2,
  User,
} from 'lucide-react';

const VISIBILITY_META: Record<
  AdminCustomSkill['visibility'],
  {
    label: string;
    description: string;
    tone: 'neutral' | 'accent' | 'blue' | 'amber' | 'danger' | 'success';
  }
> = {
  private: {
    label: '私有',
    description: '仅技能拥有者自己可见，不对外生成分享入口。',
    tone: 'neutral',
  },
  link_shared: {
    label: '私密分享',
    description: '可通过分享令牌访问，但不会公开上架展示。',
    tone: 'blue',
  },
  shared: {
    label: '公开上架',
    description: '技能允许公开展示与安装，适合正式发布。',
    tone: 'amber',
  },
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

function SectionCard({
  title,
  hint,
  icon: Icon,
  children,
}: {
  title: string;
  hint?: string;
  icon?: React.ComponentType<{ size?: number; className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-xl border border-hairline bg-surface-card p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {Icon ? <Icon size={14} className="text-muted shrink-0" /> : null}
            <h2 className="text-[14px] font-semibold">{title}</h2>
          </div>
          {hint ? <p className="mt-1 text-[12px] text-muted">{hint}</p> : null}
        </div>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function InfoRow({
  label,
  value,
  hint,
  mono = false,
}: {
  label: string;
  value: string;
  hint?: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-lg border border-hairline bg-canvas px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wider text-muted">
        {label}
      </div>
      <div
        className={`mt-1 min-w-0 text-[13px] font-medium ${mono ? 'font-mono break-all' : 'break-words'}`}
      >
        {value}
      </div>
      {hint ? (
        <div className="mt-1 text-[11px] leading-relaxed text-muted">
          {hint}
        </div>
      ) : null}
    </div>
  );
}

function buildBackHref(userId: string, visibility: string, storage: string) {
  const params = new URLSearchParams();
  if (userId) params.set('user_id', userId);
  if (visibility) params.set('visibility', visibility);
  if (storage) params.set('storage', storage);
  const qs = params.toString();
  return `/skills${qs ? `?${qs}` : ''}`;
}

function AdminSkillDetailContent() {
  const searchParams = useSearchParams();
  const skillId = searchParams.get('id') || '';
  const selectedUserId = searchParams.get('user_id') || '';
  const selectedVisibility = searchParams.get('visibility') || '';
  const selectedStorage = searchParams.get('storage') || '';

  const backHref = useMemo(
    () => buildBackHref(selectedUserId, selectedVisibility, selectedStorage),
    [selectedUserId, selectedVisibility, selectedStorage],
  );

  const [skill, setSkill] = useState<AdminCustomSkill | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');

  const loadSkill = useCallback(async () => {
    if (!skillId) {
      setSkill(null);
      setError('缺少技能 ID');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError('');
    try {
      const detail = await admin.customSkill(skillId);
      setSkill(detail);
    } catch (err) {
      if (err instanceof AdminApiError && err.status === 404) {
        setError('技能不存在或已删除');
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        throw err;
      }
      setSkill(null);
    } finally {
      setLoading(false);
    }
  }, [skillId]);

  const handleStateChange = useCallback(
    async (data: {
      enabled?: boolean;
      visibility?: AdminCustomSkill['visibility'];
    }) => {
      if (!skill) return;
      setBusy(true);
      setActionError('');
      try {
        const updated = await admin.updateCustomSkillState(skill.id, data);
        setSkill(updated);
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
    [skill],
  );

  useEffect(() => {
    loadSkill();
  }, [loadSkill]);

  if (loading) {
    return (
      <div className="min-h-[40dvh] flex items-center justify-center">
        <Loader2 size={20} className="animate-spin text-muted" />
      </div>
    );
  }

  if (!skill) {
    return (
      <div className="space-y-4">
        <a
          href={toAdminDocumentHref(backHref)}
          className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink transition-colors"
        >
          <ArrowLeft size={14} />
          返回技能列表
        </a>

        <div className="rounded-xl border border-hairline bg-surface-card p-8 text-center">
          <div className="text-[15px] font-medium">{error || '未找到技能'}</div>
          <p className="mt-2 text-[13px] text-muted">
            请确认链接参数是否完整，或返回列表重新选择技能。
          </p>
          {skillId ? (
            <button
              type="button"
              onClick={loadSkill}
              className="mt-4 inline-flex h-9 items-center gap-2 rounded-md border border-hairline px-3 text-[13px] text-muted hover:text-ink hover:bg-surface-cream-strong transition-colors cursor-pointer"
            >
              <RefreshCw size={14} />
              重试
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  const visibility = VISIBILITY_META[skill.visibility];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <a
          href={toAdminDocumentHref(backHref)}
          className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink transition-colors"
        >
          <ArrowLeft size={14} />
          返回技能列表
        </a>

        <button
          type="button"
          onClick={loadSkill}
          className="inline-flex h-9 items-center gap-2 rounded-md border border-hairline bg-surface-card px-3 text-[13px] text-muted hover:text-ink hover:bg-surface-cream-strong transition-colors cursor-pointer"
        >
          <RefreshCw size={14} />
          刷新详情
        </button>
      </div>

      <section className="rounded-xl border border-hairline bg-surface-card p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="min-w-0 break-words text-xl font-semibold tracking-tight">
            {skill.skill_name}
          </h1>
          <div className="flex flex-wrap gap-1.5">
            <SkillStorageBadge storage={skill.storage} />
            <MetaPill tone={skill.enabled ? 'success' : 'danger'}>
              {skill.enabled ? '启用中' : '已关闭'}
            </MetaPill>
            <MetaPill tone={visibility.tone}>
              <Share2 size={10} />
              {visibility.label}
            </MetaPill>
          </div>
        </div>

        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          {skill.description || '暂无技能说明'}
        </p>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted">
            <span className="inline-flex items-center gap-1.5">
              <User size={12} />
              {skill.phone || '未绑定手机号'}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Calendar size={12} />
              创建于 {formatDate(skill.created_at)}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Clock3 size={12} />
              更新于 {formatDate(skill.updated_at)}
            </span>
          </div>

          <dl
            aria-label="技能统计"
            className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px]"
          >
            <div className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
              <dt className="text-muted">内容</dt>
              <dd className="font-medium tabular-nums text-ink">
                {skill.content_length.toLocaleString()} 字
              </dd>
            </div>
            <div className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
              <dt className="text-muted">文件</dt>
              <dd className="font-medium tabular-nums text-ink">
                {skill.storage.file_count} 个
              </dd>
            </div>
            <div className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
              <dt className="text-muted">修订</dt>
              <dd className="font-medium tabular-nums text-ink">
                {skill.storage.revision_count} 次保存
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <SkillFileBrowser
        key={`${skill.id}:${skill.storage.current_revision_id ?? ''}`}
        files={skill.files}
        revisionId={skill.storage.current_revision_id}
      />

      <div className="grid gap-6 xl:grid-cols-[320px_minmax(0,1fr)]">
        <div className="order-2 min-w-0 space-y-4 xl:order-1">
          <SectionCard
            title="管理操作"
            hint="直接在详情页启停技能或调整分享可见性。"
            icon={RefreshCw}
          >
            <div className="space-y-3">
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  handleStateChange({
                    enabled: !skill.enabled,
                  })
                }
                className={`inline-flex h-10 w-full items-center justify-center rounded-lg border text-[13px] font-medium transition-colors disabled:opacity-50 cursor-pointer ${
                  skill.enabled
                    ? 'border-red-500/30 text-red-400 hover:bg-red-500/10'
                    : 'border-primary/30 text-primary hover:bg-primary/10'
                }`}
              >
                {busy ? '处理中...' : skill.enabled ? '关闭技能' : '启用技能'}
              </button>

              <div className="grid gap-2">
                {(
                  [
                    'private',
                    'link_shared',
                    'shared',
                  ] as AdminCustomSkill['visibility'][]
                ).map((nextVisibility) => {
                  const active = skill.visibility === nextVisibility;
                  return (
                    <button
                      key={nextVisibility}
                      type="button"
                      disabled={busy || active}
                      onClick={() =>
                        handleStateChange({
                          visibility: nextVisibility,
                        })
                      }
                      className={`inline-flex h-9 items-center justify-center rounded-md border px-3 text-[12px] transition-colors disabled:opacity-50 cursor-pointer ${
                        active
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-hairline text-muted hover:text-ink hover:bg-surface-cream-strong'
                      }`}
                    >
                      {VISIBILITY_META[nextVisibility].label}
                    </button>
                  );
                })}
              </div>

              <div className="rounded-lg border border-hairline bg-canvas px-3 py-2.5">
                <div className="text-[10px] uppercase tracking-wider text-muted">
                  分享令牌
                </div>
                <div className="mt-1 break-all font-mono text-[12px] text-ink">
                  {skill.share_token || '当前未生成分享令牌'}
                </div>
              </div>

              {actionError ? (
                <p className="text-[12px] text-error">{actionError}</p>
              ) : null}
            </div>
          </SectionCard>

          <SectionCard title="基本信息" icon={User}>
            <div className="grid gap-2">
              <InfoRow label="技能 ID" value={skill.id} mono />
              <InfoRow label="用户 ID" value={skill.user_id} mono />
              <InfoRow label="用户标识" value={skill.phone || '未绑定手机号'} />
              <InfoRow
                label="可见性"
                value={visibility.label}
                hint={visibility.description}
              />
              <InfoRow label="创建时间" value={formatDate(skill.created_at)} />
              <InfoRow label="更新时间" value={formatDate(skill.updated_at)} />
            </div>
          </SectionCard>
        </div>

        <div className="order-1 min-w-0 space-y-4 xl:order-2">
          <SectionCard
            title="数据库内容"
            hint="当前修订决定后续请求读取的内容，保存新修订不会覆盖正在使用的快照。"
            icon={Database}
          >
            <div
              className={`rounded-lg border px-4 py-3 ${skill.storage.state === 'stored' ? 'border-success/25 bg-success/5' : 'border-warning/30 bg-warning/5'}`}
            >
              <SkillStorageBadge storage={skill.storage} />
              <p className="mt-2 text-[13px] leading-relaxed text-muted">
                {SKILL_STORAGE_META[skill.storage.state].description}
              </p>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <InfoRow
                label="当前修订 ID"
                value={skill.storage.current_revision_id || '尚无数据库修订'}
                mono
              />
              <InfoRow
                label="修订保存时间"
                value={formatDate(skill.storage.revision_created_at)}
              />
              <InfoRow
                label="内容格式"
                value={
                  skill.storage.format_version === 1
                    ? '文本 Skill · 格式 1'
                    : skill.storage.format_version
                      ? `格式 ${skill.storage.format_version}`
                      : '尚未入库'
                }
              />
              <InfoRow
                label="内容来源"
                value={
                  skill.storage.current_revision_id
                    ? 'PostgreSQL'
                    : '等待导入原文件'
                }
              />
            </div>
            <details className="mt-4 rounded-lg border border-hairline bg-canvas px-3 py-2.5">
              <summary className="cursor-pointer text-[12px] font-medium text-muted">
                迁移与技术信息
              </summary>
              <div className="mt-3 grid gap-2">
                <InfoRow
                  label="内容校验值（SHA-256）"
                  value={skill.checksum || '尚未生成'}
                  hint="用于确认文件内容是否一致，不表示版本先后。"
                  mono
                />
                <InfoRow
                  label={
                    skill.storage.current_revision_id
                      ? '数据库引用'
                      : '原文件位置'
                  }
                  value={skill.bundle_uri || '未记录'}
                  mono
                />
                <InfoRow
                  label="旧文件迁移"
                  value={
                    skill.storage.import_status === 'complete'
                      ? '迁移完成'
                      : skill.storage.current_revision_id
                        ? '无需迁移'
                        : SKILL_STORAGE_META[skill.storage.state].label
                  }
                />
                <InfoRow
                  label="最近迁移检查"
                  value={formatDate(skill.storage.import_checked_at)}
                />
                {skill.storage.import_error_code ? (
                  <InfoRow
                    label="迁移诊断代码"
                    value={skill.storage.import_error_code}
                    mono
                  />
                ) : null}
              </div>
            </details>
          </SectionCard>

          <SectionCard
            title="修订记录"
            hint={`共 ${skill.storage.revision_count} 次保存，展示最近 ${skill.revisions.length} 次。`}
            icon={History}
          >
            {skill.revisions.length ? (
              <div className="overflow-x-auto rounded-lg border border-hairline bg-canvas">
                <table className="w-full min-w-[520px] text-left text-[12px]">
                  <thead className="border-b border-hairline text-[11px] text-muted">
                    <tr>
                      <th className="px-3 py-2.5 font-medium">修订</th>
                      <th className="px-3 py-2.5 font-medium">保存时间</th>
                      <th className="px-3 py-2.5 font-medium">文件 / 字符</th>
                      <th className="px-3 py-2.5 font-medium">内容校验值</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-hairline">
                    {skill.revisions.map((revision) => (
                      <tr key={revision.id}>
                        <td className="px-3 py-3">
                          <span className="font-mono" title={revision.id}>
                            {shortRevision(revision.id)}
                          </span>
                          {revision.id === skill.storage.current_revision_id ? (
                            <span className="ml-2 text-[10px] text-primary">
                              当前修订
                            </span>
                          ) : null}
                        </td>
                        <td className="px-3 py-3 text-muted">
                          {formatDate(revision.created_at)}
                        </td>
                        <td className="px-3 py-3 tabular-nums">
                          {revision.file_count} 个 /{' '}
                          {revision.content_length.toLocaleString()} 字
                        </td>
                        <td
                          className="px-3 py-3 font-mono text-muted"
                          title={revision.checksum}
                        >
                          {revision.checksum.slice(0, 12)}…
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="rounded-lg border border-dashed border-hairline px-4 py-6 text-center text-[13px] text-muted">
                完成内容入库后，这里会保留每次保存的修订记录。
              </p>
            )}
          </SectionCard>
        </div>
      </div>
    </div>
  );
}

export default function AdminSkillDetailPage() {
  return (
    <Suspense>
      <AdminSkillDetailContent />
    </Suspense>
  );
}
