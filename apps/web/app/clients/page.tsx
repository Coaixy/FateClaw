'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  History,
  Loader2,
  MapPin,
  MessageSquare,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Users,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { ClientProfileForm } from '@/components/clients/client-profile-form';
import type {
  ClientProfile,
  ClientProfileUpsert,
  ClientStatus,
} from '@/features/chat/client-profiles-api';
import { useClientProfiles } from '@/features/chat/hooks/use-client-profiles';
import { useAuth } from '@/features/auth/hooks/use-auth';
import { useConfirm } from '@/lib/use-confirm';
import { useI18n } from '@/lib/i18n';
import { useToast } from '@/lib/use-toast';

const CLIENTS_PAGE_SIZE = 6;

/** 客户状态筛选项（含"全部"）。 */
const STATUS_FILTERS: readonly { value: ClientStatus | 'all'; labelKey: string }[] = [
  { value: 'all', labelKey: 'clients.filter.allStatus' },
  { value: 'vip', labelKey: 'clients.status.vip' },
  { value: 'follow_up', labelKey: 'clients.status.followUp' },
  { value: 'done', labelKey: 'clients.status.done' },
];

/** 客户状态徽章样式（边框/底色/文字）。 */
const STATUS_BADGE_CLASS: Record<ClientStatus, string> = {
  vip: 'border-amber-400/40 bg-amber-400/10 text-amber-500',
  follow_up: 'border-primary/35 bg-primary/10 text-primary',
  done: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-500',
};

/** 客户状态对应的 i18n 文案键。 */
const STATUS_LABEL_KEY: Record<ClientStatus, string> = {
  vip: 'clients.status.vip',
  follow_up: 'clients.status.followUp',
  done: 'clients.status.done',
};

type FormState =
  | { mode: 'create' }
  | { mode: 'edit'; profile: ClientProfile }
  | null;

function normalizeSearch(value: string) {
  return value.trim().toLowerCase();
}

/** 把客户档案的可搜索字段拼成命中判断，姓名/出生地/备注都参与匹配。 */
function matchesSearch(profile: ClientProfile, query: string): boolean {
  if (!query) return true;
  return [profile.name, profile.birthplace, profile.notes].some((field) =>
    String(field ?? '').toLowerCase().includes(query),
  );
}

export default function ClientsPage() {
  const router = useRouter();
  const { user } = useAuth();
  const { toast } = useToast();
  const { confirm: confirmDialog } = useConfirm();
  const { formatDate, formatNumber, t } = useI18n();

  const notify = useCallback(
    (type: 'success' | 'error', message: string) => toast(type, message),
    [toast],
  );
  const { profiles, loading, loadProfiles, create, update, remove } =
    useClientProfiles(notify);

  const [initialLoaded, setInitialLoaded] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<ClientStatus | 'all'>('all');
  const [page, setPage] = useState(1);
  const [formState, setFormState] = useState<FormState>(null);
  const [deletingId, setDeletingId] = useState('');

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    loadProfiles()
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setInitialLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [loadProfiles, user]);

  const filteredProfiles = useMemo(() => {
    const query = normalizeSearch(search);
    return profiles.filter(
      (profile) =>
        matchesSearch(profile, query) &&
        (statusFilter === 'all' || profile.status === statusFilter),
    );
  }, [profiles, search, statusFilter]);

  const totalPages = Math.max(
    1,
    Math.ceil(filteredProfiles.length / CLIENTS_PAGE_SIZE),
  );
  const currentPage = Math.min(page, totalPages);
  const pagedProfiles = filteredProfiles.slice(
    (currentPage - 1) * CLIENTS_PAGE_SIZE,
    currentPage * CLIENTS_PAGE_SIZE,
  );

  useEffect(() => {
    setPage(1);
  }, [search, statusFilter]);

  const showSkeleton = loading && !initialLoaded;

  const handleCreate = async (data: ClientProfileUpsert) => {
    await create(data);
    setFormState(null);
    toast('success', t('clients.toast.created'));
  };

  const handleUpdate = async (data: ClientProfileUpsert) => {
    if (formState?.mode !== 'edit') return;
    await update(formState.profile.id, data);
    setFormState(null);
    toast('success', t('clients.toast.updated'));
  };

  const handleDelete = async (profile: ClientProfile) => {
    const ok = await confirmDialog({
      title: t('clients.deleteTitle'),
      message: t('clients.deleteMessage', { name: profile.name }),
      confirmLabel: t('clients.deleteConfirm'),
      variant: 'danger',
    });
    if (!ok) return;
    setDeletingId(profile.id);
    try {
      await remove(profile.id);
      toast('success', t('clients.toast.deleted'));
    } catch (err) {
      toast(
        'error',
        err instanceof Error ? err.message : t('clients.toast.deleteFailed'),
      );
    } finally {
      setDeletingId('');
    }
  };

  return (
    <AppShell>
      <div className="max-w-4xl mx-auto space-y-8">
        {/* Header */}
        <header className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              {t('clients.title')}
            </h1>
            <p className="mt-1 text-sm text-muted">
              {t('clients.description')}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setFormState({ mode: 'create' })}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-primary text-white text-sm font-medium hover:opacity-90 transition-opacity"
          >
            <Plus className="w-4 h-4" />
            {t('clients.newClient')}
          </button>
        </header>

        {/* List */}
        <section className="space-y-3">
          {showSkeleton ? (
            <ClientsSkeleton />
          ) : profiles.length === 0 ? (
            <EmptyState
              title={t('clients.emptyTitle')}
              description={t('clients.emptyDescription')}
              actionLabel={t('clients.newClient')}
              onAction={() => setFormState({ mode: 'create' })}
            />
          ) : (
            <>
              <div className="relative">
                <Search
                  size={15}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-muted"
                />
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t('clients.searchPlaceholder')}
                  aria-label={t('clients.searchPlaceholder')}
                  className="w-full h-10 pl-9 pr-3 rounded-xl border border-hairline bg-surface-card text-[13px] placeholder:text-muted focus:border-primary focus:outline-none transition-all"
                />
              </div>

              {/* 状态筛选:卦师按 VIP/待跟进/已完成 快速过滤客户 */}
              <div className="flex flex-wrap gap-1.5">
                {STATUS_FILTERS.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => setStatusFilter(item.value)}
                    className={`h-8 rounded-lg border px-3 text-[12px] font-medium transition-all ${
                      statusFilter === item.value
                        ? 'border-primary/30 bg-primary/12 text-primary'
                        : 'border-hairline bg-surface-card text-muted hover:border-primary/25 hover:text-ink'
                    }`}
                    aria-pressed={statusFilter === item.value}
                  >
                    {t(item.labelKey)}
                  </button>
                ))}
              </div>

              {filteredProfiles.length === 0 ? (
                <div className="relative py-10 text-center rounded-2xl border border-dashed border-hairline overflow-hidden">
                  <div className="relative flex flex-col items-center gap-2">
                    <Search size={18} className="text-muted/55" />
                    <p className="text-[12px] text-muted opacity-70">
                      {t('clients.noSearchResults', { query: search.trim() })}
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  <div className="space-y-3">
                    {pagedProfiles.map((profile) => (
                      <ClientCard
                        key={profile.id}
                        profile={profile}
                        deleting={deletingId === profile.id}
                        formatDate={formatDate}
                        formatNumber={formatNumber}
                        t={t}
                        onEdit={() =>
                          setFormState({ mode: 'edit', profile })
                        }
                        onDelete={() => void handleDelete(profile)}
                        onStartReading={() =>
                          router.push(
                            `/ai-chat?client=${encodeURIComponent(profile.id)}`,
                          )
                        }
                        onViewHistory={() =>
                          router.push(
                            `/clients/detail?id=${encodeURIComponent(profile.id)}`,
                          )
                        }
                      />
                    ))}
                  </div>

                  {filteredProfiles.length > CLIENTS_PAGE_SIZE && (
                    <div className="flex flex-col items-center justify-between gap-2 rounded-2xl border border-hairline/60 bg-surface-card/60 px-3 py-2 sm:flex-row">
                      <span className="text-[11px] text-muted tabular-nums">
                        {t('clients.paginationRange', {
                          start: formatNumber(
                            (currentPage - 1) * CLIENTS_PAGE_SIZE + 1,
                          ),
                          end: formatNumber(
                            Math.min(
                              currentPage * CLIENTS_PAGE_SIZE,
                              filteredProfiles.length,
                            ),
                          ),
                          total: formatNumber(filteredProfiles.length),
                        })}
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setPage((value) => Math.max(1, value - 1))}
                          disabled={currentPage <= 1}
                          className="inline-flex h-8 items-center gap-1 rounded-full px-3 text-[11px] text-muted transition-all hover:bg-surface-cream-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-35"
                        >
                          <ChevronLeft size={13} />
                          {t('clients.previousPage')}
                        </button>
                        <span className="inline-flex h-8 min-w-14 items-center justify-center rounded-full bg-surface-cream-strong px-2 text-[11px] tabular-nums text-ink">
                          {t('clients.pageIndicator', {
                            page: formatNumber(currentPage),
                            total: formatNumber(totalPages),
                          })}
                        </span>
                        <button
                          onClick={() =>
                            setPage((value) => Math.min(totalPages, value + 1))
                          }
                          disabled={currentPage >= totalPages}
                          className="inline-flex h-8 items-center gap-1 rounded-full px-3 text-[11px] text-muted transition-all hover:bg-surface-cream-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-35"
                        >
                          {t('clients.nextPage')}
                          <ChevronRight size={13} />
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </section>
      </div>

      {formState && (
        <ClientProfileForm
          initial={formState.mode === 'edit' ? formState.profile : undefined}
          onSave={formState.mode === 'edit' ? handleUpdate : handleCreate}
          onCancel={() => setFormState(null)}
        />
      )}
    </AppShell>
  );
}

function ClientCard({
  profile,
  deleting,
  formatDate,
  formatNumber,
  t,
  onEdit,
  onDelete,
  onStartReading,
  onViewHistory,
}: {
  profile: ClientProfile;
  deleting: boolean;
  formatDate: (
    value: string | number | Date,
    options?: Intl.DateTimeFormatOptions,
  ) => string;
  formatNumber: (value: number) => string;
  t: (key: string, params?: Record<string, string | number>) => string;
  onEdit: () => void;
  onDelete: () => void;
  onStartReading: () => void;
  onViewHistory: () => void;
}) {
  const genderLabel =
    profile.gender === '男'
      ? t('clients.gender.male')
      : profile.gender === '女'
        ? t('clients.gender.female')
        : null;
  const birthLabel = profile.solar_date
    ? typeof profile.hour === 'number'
      ? t('clients.card.birthWithTime', {
          date: profile.solar_date,
          hour: String(profile.hour).padStart(2, '0'),
          minute: String(profile.minute ?? 0).padStart(2, '0'),
        })
      : profile.solar_date
    : t('clients.card.birthUnknown');
  const sessionCount = profile.session_count ?? 0;

  return (
    <div className="group rounded-2xl border border-hairline bg-surface-card p-4 transition-colors hover:border-primary/25">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Users size={17} strokeWidth={1.8} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-[15px] font-semibold text-ink">
                {profile.name}
              </span>
              {genderLabel && (
                <span className="shrink-0 rounded-md bg-surface-cream-strong px-1.5 py-0.5 text-[10px] text-muted">
                  {genderLabel}
                </span>
              )}
              {profile.status && (
                <span
                  className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${STATUS_BADGE_CLASS[profile.status]}`}
                >
                  {t(STATUS_LABEL_KEY[profile.status])}
                </span>
              )}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
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
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted/80">
              <span className="inline-flex items-center gap-1">
                <MessageSquare size={11} strokeWidth={1.8} />
                {t('clients.card.sessionCount', {
                  count: formatNumber(sessionCount),
                })}
              </span>
              <span>
                {profile.last_session_at
                  ? t('clients.card.lastSession', {
                      time: formatDate(profile.last_session_at, {
                        month: 'short',
                        day: 'numeric',
                      }),
                    })
                  : t('clients.card.neverConsulted')}
              </span>
            </div>
            {profile.notes && (
              <p className="mt-2 line-clamp-2 text-[12px] leading-relaxed text-muted">
                {profile.notes}
              </p>
            )}
            {profile.tags.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {profile.tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center rounded-md bg-primary/8 px-1.5 py-0.5 text-[10px] text-primary/90"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onEdit}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-cream-strong hover:text-ink"
            aria-label={t('clients.edit')}
            title={t('clients.edit')}
          >
            <Pencil size={14} />
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={deleting}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-red-400/10 hover:text-red-400 disabled:cursor-wait disabled:opacity-50"
            aria-label={t('clients.delete')}
            title={t('clients.delete')}
          >
            {deleting ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Trash2 size={14} />
            )}
          </button>
        </div>
      </div>

      {/* 操作:发起排盘(带客户进排盘) / 查看历史(该客户全部会话) */}
      <div className="mt-3 flex items-center gap-2 border-t border-hairline/50 pt-3">
        <button
          type="button"
          onClick={onStartReading}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-primary/25 bg-primary/8 px-3 text-[12px] font-medium text-primary transition-colors hover:border-primary/45 hover:bg-primary/12"
        >
          <Sparkles size={13} strokeWidth={1.8} />
          {t('clients.card.startReading')}
        </button>
        <button
          type="button"
          onClick={onViewHistory}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-hairline bg-canvas px-3 text-[12px] font-medium text-muted transition-colors hover:border-primary/30 hover:text-ink"
        >
          <History size={13} strokeWidth={1.8} />
          {t('clients.card.viewHistory')}
        </button>
      </div>
    </div>
  );
}

function ClientsSkeleton() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((index) => (
        <div
          key={index}
          className="rounded-2xl border border-hairline bg-surface-card p-4"
        >
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 shrink-0 animate-pulse rounded-xl bg-muted/10" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-32 animate-pulse rounded-full bg-muted/12" />
              <div className="h-3 w-48 animate-pulse rounded-full bg-muted/10" />
              <div className="h-3 w-24 animate-pulse rounded-full bg-muted/10" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
}: {
  title: string;
  description: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="group relative overflow-hidden rounded-2xl border border-dashed border-hairline py-14 transition-all duration-300 hover:border-[color-mix(in_srgb,var(--color-primary)_50%,var(--color-hairline))]">
      <div className="relative flex flex-col items-center text-center">
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-hairline bg-surface-card">
          <Users
            size={20}
            className="text-muted transition-colors group-hover:text-primary"
          />
        </div>
        <p className="max-w-[18rem] text-[14px] font-medium text-muted transition-colors group-hover:text-ink">
          {title}
        </p>
        <p className="mt-1.5 max-w-[22rem] text-[12px] text-muted opacity-60">
          {description}
        </p>
        <button
          type="button"
          onClick={onAction}
          className="mt-5 inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-[12px] font-semibold text-white transition-opacity hover:opacity-90"
        >
          <Plus size={13} />
          {actionLabel}
        </button>
      </div>
    </div>
  );
}
