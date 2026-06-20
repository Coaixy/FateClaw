'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Archive,
  ArrowLeft,
  CalendarDays,
  Loader2,
  MapPin,
  MessageCircle,
  Sparkles,
  Users,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { chatSessionsApi, type ChatSession } from '@/features/chat/api';
import {
  clientProfilesApi,
  type ClientProfile,
  type ClientStatus,
} from '@/features/chat/client-profiles-api';
import { useAuth } from '@/features/auth/hooks/use-auth';
import { useI18n } from '@/lib/i18n';

/** 客户状态徽章样式（与列表页保持一致）。 */
const STATUS_BADGE_CLASS: Record<ClientStatus, string> = {
  vip: 'border-amber-400/40 bg-amber-400/10 text-amber-500',
  follow_up: 'border-primary/35 bg-primary/10 text-primary',
  done: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-500',
};

const STATUS_LABEL_KEY: Record<ClientStatus, string> = {
  vip: 'clients.status.vip',
  follow_up: 'clients.status.followUp',
  done: 'clients.status.done',
};

/**
 * 客户档案详情 / 断卦历史页。
 *
 * 用查询参数 `?id=` 承载客户 id（适配静态导出，无需动态路由）。展示客户基础信息、
 * 一键发起排盘入口，以及该客户名下的全部会话（活跃 + 已归档）统一历史。
 *
 * @returns 客户详情页。
 */
export default function ClientDetailPage() {
  return (
    <Suspense
      fallback={
        <AppShell>
          <div className="flex min-h-[40vh] items-center justify-center">
            <Loader2 size={20} className="animate-spin text-muted" />
          </div>
        </AppShell>
      }
    >
      <ClientDetailContent />
    </Suspense>
  );
}

function ClientDetailContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const clientId = searchParams.get('id') ?? '';
  const { user } = useAuth();
  const { t, formatDate } = useI18n();

  const [profile, setProfile] = useState<ClientProfile | null>(null);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user || !clientId) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError('');
    Promise.all([
      clientProfilesApi.get(clientId),
      chatSessionsApi.byClient(clientId),
    ])
      .then(([loadedProfile, loadedSessions]) => {
        if (cancelled) return;
        setProfile(loadedProfile);
        setSessions(loadedSessions);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : t('clients.detail.loadFailed'),
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user, clientId, t]);

  const birthLabel = profile?.solar_date
    ? typeof profile.hour === 'number'
      ? t('clients.card.birthWithTime', {
          date: profile.solar_date,
          hour: String(profile.hour).padStart(2, '0'),
          minute: String(profile.minute ?? 0).padStart(2, '0'),
        })
      : profile.solar_date
    : t('clients.card.birthUnknown');

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl space-y-6">
        <Link
          href="/clients"
          className="inline-flex items-center gap-1.5 text-[13px] text-muted transition-colors hover:text-ink"
        >
          <ArrowLeft size={15} />
          {t('clients.detail.back')}
        </Link>

        {loading ? (
          <div className="flex min-h-[30vh] items-center justify-center">
            <Loader2 size={20} className="animate-spin text-muted" />
          </div>
        ) : error || !profile ? (
          <div className="rounded-2xl border border-dashed border-hairline py-14 text-center text-[13px] text-muted">
            {error || t('clients.detail.notFound')}
          </div>
        ) : (
          <>
            {/* 客户信息头部 */}
            <header className="rounded-2xl border border-hairline bg-surface-card p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 items-start gap-3">
                  <div className="mt-0.5 flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <Users size={20} strokeWidth={1.8} />
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h1 className="text-xl font-bold tracking-tight text-ink">
                        {profile.name}
                      </h1>
                      {profile.gender && (
                        <span className="rounded-md bg-surface-cream-strong px-1.5 py-0.5 text-[11px] text-muted">
                          {profile.gender === '男'
                            ? t('clients.gender.male')
                            : t('clients.gender.female')}
                        </span>
                      )}
                      {profile.status && (
                        <span
                          className={`rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${STATUS_BADGE_CLASS[profile.status]}`}
                        >
                          {t(STATUS_LABEL_KEY[profile.status])}
                        </span>
                      )}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
                      <span className="inline-flex items-center gap-1">
                        <CalendarDays size={12} strokeWidth={1.8} />
                        {birthLabel}
                      </span>
                      {profile.birthplace && (
                        <span className="inline-flex items-center gap-1">
                          <MapPin size={12} strokeWidth={1.8} />
                          {profile.birthplace}
                        </span>
                      )}
                    </div>
                    {profile.tags.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {profile.tags.map((tag) => (
                          <span
                            key={tag}
                            className="inline-flex items-center rounded-md bg-primary/8 px-1.5 py-0.5 text-[11px] text-primary/90"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                    {profile.notes && (
                      <p className="mt-2 text-[12px] leading-relaxed text-muted">
                        {profile.notes}
                      </p>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    router.push(
                      `/ai-chat?client=${encodeURIComponent(profile.id)}`,
                    )
                  }
                  className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-primary px-4 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
                >
                  <Sparkles size={14} />
                  {t('clients.card.startReading')}
                </button>
              </div>
            </header>

            {/* 断卦历史:活跃 + 已归档统一列出 */}
            <section className="space-y-3">
              <h2 className="px-0.5 text-[13px] font-semibold text-ink">
                {t('clients.detail.sessionsTitle')}
                <span className="ml-1.5 text-[12px] font-normal text-muted">
                  {sessions.length}
                </span>
              </h2>

              {sessions.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-hairline py-12 text-center text-[12px] text-muted">
                  {t('clients.detail.empty')}
                </div>
              ) : (
                <div className="space-y-2">
                  {sessions.map((session) => {
                    const archived = Boolean(session.deleted_at);
                    const body = (
                      <>
                        <div
                          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                            archived
                              ? 'bg-surface-cream-strong text-muted/60'
                              : 'bg-primary/10 text-primary'
                          }`}
                        >
                          {archived ? (
                            <Archive size={14} strokeWidth={1.8} />
                          ) : (
                            <MessageCircle size={14} strokeWidth={1.8} />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-medium text-ink">
                            {session.title}
                          </p>
                          <p className="mt-0.5 text-[11px] text-muted">
                            {formatDate(session.updated_at, {
                              year: 'numeric',
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </p>
                        </div>
                        {archived && (
                          <span className="shrink-0 rounded-md bg-surface-cream-strong px-1.5 py-0.5 text-[10px] text-muted">
                            {t('clients.detail.archivedBadge')}
                          </span>
                        )}
                      </>
                    );

                    // 活跃会话可直接打开；已归档会话仅展示(需先到归档页恢复)。
                    return archived ? (
                      <div
                        key={session.id}
                        className="flex items-center gap-3 rounded-2xl border border-hairline bg-surface-card/60 px-3.5 py-3"
                      >
                        {body}
                      </div>
                    ) : (
                      <Link
                        key={session.id}
                        href={`/ai-chat?sid=${encodeURIComponent(session.id)}`}
                        className="flex items-center gap-3 rounded-2xl border border-hairline bg-surface-card px-3.5 py-3 transition-colors hover:border-primary/30"
                      >
                        {body}
                      </Link>
                    );
                  })}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </AppShell>
  );
}
