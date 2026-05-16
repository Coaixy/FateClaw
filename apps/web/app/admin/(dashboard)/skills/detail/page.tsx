'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { admin, AdminApiError, AdminCustomSkill } from '@/lib/admin-api';
import { toAdminDocumentHref } from '@/lib/admin-navigation';
import {
  ArrowLeft,
  BookOpen,
  Calendar,
  Clock3,
  FileText,
  Hash,
  Loader2,
  RefreshCw,
  Share2,
  User,
  Zap,
} from 'lucide-react';

function formatDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const USAGE_MODE_META: Record<
  AdminCustomSkill['usage_mode'],
  {
    label: string;
    description: string;
    tone: 'neutral' | 'accent' | 'blue' | 'amber' | 'danger' | 'success';
  }
> = {
  force_injected: {
    label: '强规则',
    description: '命中后全文注入解读上下文，适合必须被体现的规则与口径。',
    tone: 'danger',
  },
  reference_only: {
    label: '参考知识',
    description: '作为补充背景知识使用，不强制覆盖默认路由。',
    tone: 'success',
  },
};

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
    <section className="rounded-xl border border-hairline bg-surface-card p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {Icon ? (
              <Icon size={14} className="text-muted shrink-0" />
            ) : null}
            <h2 className="text-[14px] font-semibold">{title}</h2>
          </div>
          {hint ? (
            <p className="mt-1 text-[12px] text-muted">{hint}</p>
          ) : null}
        </div>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-hairline bg-canvas px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wider text-muted">
        {label}
      </div>
      <div className="mt-1 text-[14px] font-medium text-ink">
        {value}
      </div>
    </div>
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
        className={`mt-1 text-[13px] font-medium break-words ${mono ? 'font-mono' : ''}`}
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

function buildBackHref(userId: string, visibility: string) {
  const params = new URLSearchParams();
  if (userId) params.set('user_id', userId);
  if (visibility) params.set('visibility', visibility);
  const qs = params.toString();
  return `/admin/skills${qs ? `?${qs}` : ''}`;
}

function AdminSkillDetailContent() {
  const searchParams = useSearchParams();
  const skillId = searchParams.get('id') || '';
  const selectedUserId = searchParams.get('user_id') || '';
  const selectedVisibility = searchParams.get('visibility') || '';

  const backHref = useMemo(
    () => buildBackHref(selectedUserId, selectedVisibility),
    [selectedUserId, selectedVisibility],
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

  const usageMode = USAGE_MODE_META[skill.usage_mode];
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

      <section className="rounded-2xl border border-hairline bg-surface-card p-5 sm:p-6">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap gap-1.5">
              <MetaPill tone={skill.enabled ? 'success' : 'danger'}>
                {skill.enabled ? '启用中' : '已关闭'}
              </MetaPill>
              <MetaPill tone={visibility.tone}>
                <Share2 size={10} />
                {visibility.label}
              </MetaPill>
              <MetaPill tone={usageMode.tone}>
                <Zap size={10} />
                {usageMode.label}
              </MetaPill>
            </div>

            <h1 className="mt-3 text-2xl font-semibold tracking-tight break-words">
              {skill.skill_name}
            </h1>

            <p className="mt-2 text-[14px] leading-relaxed text-muted">
              {skill.description || '暂无技能说明'}
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-muted">
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
          </div>

          <div className="grid w-full gap-2 sm:grid-cols-2 xl:w-[320px]">
            <StatTile
              label="内容长度"
              value={`${skill.content.length.toLocaleString()} 字`}
            />
            <StatTile
              label="关键词"
              value={String(skill.match_keywords?.length ?? 0)}
            />
            <StatTile label="分类" value={skill.category || '通用'} />
            <StatTile
              label="分享令牌"
              value={skill.share_token ? '已生成' : '未生成'}
            />
          </div>
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-[320px_minmax(0,1fr)]">
        <div className="space-y-4">
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
                <p className="text-[12px] text-error">
                  {actionError}
                </p>
              ) : null}
            </div>
          </SectionCard>

          <SectionCard title="基本信息" icon={User}>
            <div className="grid gap-2">
              <InfoRow label="技能 ID" value={skill.id} mono />
              <InfoRow label="用户 ID" value={skill.user_id} mono />
              <InfoRow label="用户标识" value={skill.phone || '未绑定手机号'} />
              <InfoRow label="绑定类别" value={skill.category || '通用'} />
              <InfoRow
                label="路由模式"
                value={usageMode.label}
                hint={usageMode.description}
              />
              <InfoRow
                label="可见性"
                value={visibility.label}
                hint={visibility.description}
              />
              <InfoRow label="创建时间" value={formatDate(skill.created_at)} />
              <InfoRow label="更新时间" value={formatDate(skill.updated_at)} />
            </div>
          </SectionCard>

          <SectionCard
            title="匹配关键词"
            hint="管理员可快速判断该技能会在什么问题上下文中被命中。"
            icon={Hash}
          >
            {skill.match_keywords && skill.match_keywords.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {skill.match_keywords.map((kw, index) => (
                  <span
                    key={`${kw}-${index}`}
                    className="inline-flex items-center rounded-md border border-hairline bg-canvas px-2 py-1 text-[12px] text-muted"
                  >
                    {kw}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-[12px] text-muted">
                当前未配置匹配关键词。
              </p>
            )}
          </SectionCard>
        </div>

        <div className="space-y-4">
          <SectionCard
            title="技能说明"
            hint="用于快速理解这个技能解决什么问题、适合什么上下文。"
            icon={FileText}
          >
            <div className="rounded-lg border border-hairline bg-canvas px-4 py-3 text-[13px] leading-relaxed text-ink">
              {skill.description || '暂无技能说明'}
            </div>
          </SectionCard>

          {skill.trigger_hint ? (
            <SectionCard
              title="触发条件"
              hint="这是用户为该技能设置的触发提示文案。"
              icon={Zap}
            >
              <div className="rounded-lg border border-hairline bg-canvas px-4 py-3 text-[13px] leading-relaxed text-ink">
                {skill.trigger_hint}
              </div>
            </SectionCard>
          ) : null}

          <SectionCard
            title="完整内容"
            hint="展示技能实际知识正文，便于完整审阅。"
            icon={BookOpen}
          >
            <div className="max-h-[70dvh] min-h-[360px] overflow-y-auto rounded-lg border border-hairline bg-canvas px-4 py-3 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words text-ink">
              {skill.content || '(空)'}
            </div>
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
