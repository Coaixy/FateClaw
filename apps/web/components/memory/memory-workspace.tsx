'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Brain,
  History,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import type {
  MemoryEvidenceDto,
  MemoryItemDto,
  MemoryItemStatus,
  MemoryJobDto,
  MemoryListDto,
  MemorySettingsDto,
  MemoryStatusDto,
} from '@fateclaw/contracts/memory';

import { Button } from '@/components/ui/button';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { useAuth } from '@/features/auth/hooks/use-auth';
import { useChatSessions } from '@/features/chat/hooks/use-chat-sessions';
import { memoryApi, type MemoryFilters } from '@/features/memory/api';
import { useMemoryScopes } from '@/features/memory/use-memory-scopes';
import { ApiError } from '@/lib/http/client';
import { useI18n } from '@/lib/i18n';
import { useConfirm } from '@/lib/use-confirm';
import { useToast } from '@/lib/use-toast';
import {
  MemoryEditor,
  MEMORY_CONTROL,
  MEMORY_KINDS,
  type MemoryEditorDraft,
} from './memory-editor';
import { MemoryEvidencePanel } from './memory-evidence-panel';
import { MemoryJobList } from './memory-job-list';
import { MemorySpeakersPanel } from './memory-speakers-panel';
import { MemorySessionLearningPanel } from './memory-session-learning-panel';

type SettingsKey =
  | 'learning_enabled'
  | 'recall_enabled'
  | 'chat_editing_enabled';
const SETTINGS_KEYS: SettingsKey[] = [
  'learning_enabled',
  'recall_enabled',
  'chat_editing_enabled',
];
const ITEM_STATUSES: MemoryItemStatus[] = [
  'active',
  'superseded',
  'disputed',
  'forgotten',
];

export function MemoryWorkspace() {
  const { user } = useAuth();
  return <MemoryContent key={user?.id ?? 'anonymous'} />;
}

function MemoryContent() {
  const { t, formatDate, formatNumber } = useI18n();
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const { sessions, loading: sessionsLoading } = useChatSessions();
  const memoryScopes = useMemoryScopes();
  const [settings, setSettings] = useState<MemorySettingsDto | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsError, setSettingsError] = useState('');
  const [list, setList] = useState<MemoryListDto | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [status, setStatus] = useState<MemoryStatusDto | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState('');
  const [filters, setFilters] = useState<MemoryFilters>({ status: 'active' });
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState('');
  const [actionError, setActionError] = useState('');
  const [editor, setEditor] = useState<MemoryEditorDraft | null>(null);
  const [evidenceItem, setEvidenceItem] = useState<MemoryItemDto | null>(null);
  const [evidence, setEvidence] = useState<MemoryEvidenceDto[]>([]);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState('');
  const [backfillOpen, setBackfillOpen] = useState(false);
  const [backfillScope, setBackfillScope] = useState<'all' | 'selected'>('all');
  const [backfillSessions, setBackfillSessions] = useState<string[]>([]);
  const [limitBackfillScopes, setLimitBackfillScopes] = useState(false);
  const [backfillScopeIds, setBackfillScopeIds] = useState<string[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [resetContext, setResetContext] = useState(false);
  const [managementRefresh, setManagementRefresh] = useState(0);
  const alive = useRef(true);
  const pendingRef = useRef('');
  const requests = useRef(new Map<string, AbortController>());

  const request = useCallback((key: string) => {
    requests.current.get(key)?.abort();
    const controller = new AbortController();
    requests.current.set(key, controller);
    return controller.signal;
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      requests.current.forEach((controller) => controller.abort());
    };
  }, []);

  const loadSettings = useCallback(async () => {
    const signal = request('settings');
    setSettingsLoading(true);
    try {
      const result = await memoryApi.settings(signal);
      if (signal.aborted) return;
      setSettings((previous) =>
        previous && previous.revision > result.revision ? previous : result,
      );
      setSettingsError('');
    } catch (error) {
      if (!signal.aborted)
        setSettingsError(
          error instanceof Error ? error.message : t('memory.loadFailed'),
        );
    } finally {
      if (!signal.aborted) setSettingsLoading(false);
    }
  }, [request, t]);

  const loadList = useCallback(
    async (cursor?: string) => {
      const signal = request('list');
      setListLoading(true);
      setListError('');
      try {
        const result = await memoryApi.list(
          { ...filters, limit: 30, cursor },
          signal,
        );
        if (signal.aborted) return;
        setList((previous) =>
          cursor && previous
            ? {
                ...result,
                items: [
                  ...previous.items,
                  ...result.items.filter(
                    (item) =>
                      !previous.items.some(
                        (existing) => existing.id === item.id,
                      ),
                  ),
                ],
              }
            : result,
        );
      } catch (error) {
        if (!signal.aborted)
          setListError(
            error instanceof Error ? error.message : t('memory.loadFailed'),
          );
      } finally {
        if (!signal.aborted) setListLoading(false);
      }
    },
    [filters, request, t],
  );

  const loadStatus = useCallback(async () => {
    const signal = request('status');
    setStatusLoading(true);
    try {
      const result = await memoryApi.status(signal);
      if (signal.aborted) return;
      setStatus(result);
      setStatusError('');
    } catch (error) {
      if (!signal.aborted)
        setStatusError(
          error instanceof Error ? error.message : t('memory.loadFailed'),
        );
    } finally {
      if (!signal.aborted) setStatusLoading(false);
    }
  }, [request, t]);

  useEffect(() => {
    void loadSettings();
    void loadStatus();
  }, [loadSettings, loadStatus]);
  useEffect(() => {
    setList(null);
    void loadList();
  }, [loadList]);

  const hasPendingJobs = Boolean(
    status?.pending_jobs ||
    status?.recent_jobs.some((job) => job.state === 'running'),
  );
  const wasPending = useRef(false);
  useEffect(() => {
    if (!hasPendingJobs && wasPending.current) {
      void loadList();
      setManagementRefresh((value) => value + 1);
    }
    wasPending.current = hasPendingJobs;
  }, [hasPendingJobs, loadList]);
  useEffect(() => {
    if (!hasPendingJobs) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await loadStatus();
      if (stopped) return;
      await loadList();
      if (!stopped) timer = setTimeout(() => void poll(), 5_000);
    };
    timer = setTimeout(() => void poll(), 5_000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [hasPendingJobs, loadList, loadStatus]);

  const perform = async (
    key: string,
    work: (signal: AbortSignal) => Promise<void>,
    success?: string,
  ) => {
    if (pendingRef.current) return false;
    pendingRef.current = key;
    setPending(key);
    setActionError('');
    const signal = request('action');
    try {
      await work(signal);
      if (signal.aborted) return false;
      if (success) toast('success', success);
      return true;
    } catch (error) {
      if (signal.aborted) return false;
      if (error instanceof ApiError && error.status === 409) {
        setActionError(t('memory.conflict'));
        void loadSettings();
        void loadList();
      } else {
        setActionError(
          error instanceof Error ? error.message : t('memory.actionFailed'),
        );
      }
      return false;
    } finally {
      pendingRef.current = '';
      if (alive.current) setPending('');
    }
  };

  const refresh = () => {
    void loadSettings();
    void loadList();
    void loadStatus();
    void memoryScopes.refresh();
    setManagementRefresh((value) => value + 1);
  };
  const toggleSetting = (key: SettingsKey) => {
    if (!settings) return;
    void perform(
      `settings:${key}`,
      async (signal) => {
        const result = await memoryApi.updateSettings(
          { [key]: !settings[key], revision: settings.revision },
          signal,
        );
        if (!signal.aborted) setSettings(result);
      },
      t('memory.settingsSaved'),
    );
  };

  const saveEditor = async () => {
    if (!editor?.content.trim()) return;
    const success = await perform(
      'save',
      async (signal) => {
        if (editor.item)
          await memoryApi.update(
            editor.item.id,
            editor.content.trim(),
            editor.item.revision,
            signal,
          );
        else
          await memoryApi.create(
            {
              content: editor.content.trim(),
              kind: editor.kind,
              subject_id: editor.subjectId || undefined,
            },
            signal,
          );
      },
      t('memory.saved'),
    );
    if (success && alive.current) {
      setEditor(null);
      setManagementRefresh((value) => value + 1);
      void loadList();
      void loadStatus();
    }
  };

  const forgetItem = async (item: MemoryItemDto) => {
    if (
      !(await confirm({
        title: t('memory.forgetTitle'),
        message: t('memory.forgetDescription'),
        variant: 'danger',
        confirmLabel: t('memory.forget'),
      }))
    )
      return;
    const success = await perform(
      `forget:${item.id}`,
      async (signal) => {
        await memoryApi.forget(item.id, item.revision, signal);
      },
      t('memory.forgotten'),
    );
    if (success && alive.current) {
      setManagementRefresh((value) => value + 1);
      void loadList();
      void loadStatus();
    }
  };

  const loadEvidence = useCallback(
    async (item: MemoryItemDto) => {
      const signal = request('evidence');
      setEvidenceLoading(true);
      setEvidenceError('');
      try {
        const result = await memoryApi.evidence(item.id, signal);
        if (!signal.aborted) setEvidence(result.evidence);
      } catch (error) {
        if (!signal.aborted)
          setEvidenceError(
            error instanceof Error ? error.message : t('memory.loadFailed'),
          );
      } finally {
        if (!signal.aborted) setEvidenceLoading(false);
      }
    },
    [request, t],
  );

  const excludeSource = async (sourceId: string) => {
    const success = await perform(
      `source:${sourceId}`,
      async (signal) => {
        await memoryApi.excludeSource(sourceId, signal);
      },
      t('memory.sourceExcluded'),
    );
    if (success && alive.current) {
      setManagementRefresh((value) => value + 1);
      if (evidenceItem) void loadEvidence(evidenceItem);
      void loadList();
      void loadStatus();
    }
  };

  const clearMemory = async () => {
    if (
      !(await confirm({
        title: t('memory.clearTitle'),
        message: t(
          resetContext
            ? 'memory.clearWithContextDescription'
            : 'memory.clearDescription',
        ),
        variant: 'danger',
        confirmLabel: t('memory.clear'),
      }))
    )
      return;
    const success = await perform(
      'clear',
      async (signal) => {
        const result = await memoryApi.clear(resetContext, signal);
        if (!signal.aborted) setSettings(result);
      },
      t('memory.cleared'),
    );
    if (success && alive.current) {
      setResetContext(false);
      setManagementRefresh((value) => value + 1);
      void loadList();
      void loadStatus();
    }
  };

  const startBackfill = async () => {
    if (
      (backfillScope === 'selected' && backfillSessions.length === 0) ||
      (limitBackfillScopes && backfillScopeIds.length === 0) ||
      (from && to && from > to)
    )
      return;
    const success = await perform(
      'backfill',
      async (signal) => {
        const job = await memoryApi.backfill(
          {
            ...(backfillScope === 'selected'
              ? { session_ids: backfillSessions }
              : {}),
            ...(limitBackfillScopes ? { scope_ids: backfillScopeIds } : {}),
            ...(from
              ? { from: new Date(`${from}T00:00:00`).toISOString() }
              : {}),
            ...(to ? { to: new Date(`${to}T23:59:59.999`).toISOString() } : {}),
          },
          signal,
        );
        if (!signal.aborted)
          setStatus((previous) =>
            previous
              ? {
                  ...previous,
                  pending_jobs:
                    previous.pending_jobs + (job.state === 'pending' ? 1 : 0),
                  recent_jobs: [
                    job,
                    ...previous.recent_jobs.filter(
                      (existing) => existing.id !== job.id,
                    ),
                  ],
                }
              : previous,
          );
      },
      t('memory.backfillQueued'),
    );
    if (success && alive.current) {
      setBackfillOpen(false);
      void loadStatus();
    }
  };

  const jobAction = async (job: MemoryJobDto, action: 'pause' | 'resume') => {
    const success = await perform(`job:${job.id}`, async (signal) => {
      const result = await (action === 'pause'
        ? memoryApi.pauseJob(job.id, signal)
        : memoryApi.resumeJob(job.id, signal));
      if (!signal.aborted)
        setStatus((previous) =>
          previous
            ? {
                ...previous,
                recent_jobs: previous.recent_jobs.map((existing) =>
                  existing.id === job.id ? result : existing,
                ),
              }
            : previous,
        );
    });
    if (success && alive.current) void loadStatus();
  };

  return (
    <div className="space-y-5 pb-5 pt-5 lg:pt-0">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-xl">
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <Brain size={20} className="text-primary" />
            {t('memory.title')}
          </h1>
          <p className="mt-2 text-[12px] leading-6 text-muted">
            {t('memory.description')}
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          icon={<RefreshCw size={13} />}
          disabled={Boolean(pending)}
          onClick={refresh}
        >
          {t('memory.refresh')}
        </Button>
      </header>

      <section
        className="overflow-hidden rounded-2xl border border-hairline bg-surface-card/60"
        aria-label={t('memory.settingsTitle')}
      >
        {settingsError && (
          <p role="alert" className="px-4 pt-4 text-[12px] text-error">
            {settingsError}
          </p>
        )}
        <div className="divide-y divide-hairline/60">
          {SETTINGS_KEYS.map((key) => (
            <label
              key={key}
              className="flex items-center justify-between gap-4 p-4 sm:px-5"
            >
              <span className="min-w-0">
                <span className="block text-[13px] font-medium">
                  {t(`memory.settings.${key}`)}
                </span>
                <span className="mt-1 block text-[11px] leading-5 text-muted">
                  {t(`memory.settingsHints.${key}`)}
                </span>
              </span>
              <button
                type="button"
                role="switch"
                aria-label={t(`memory.settings.${key}`)}
                aria-checked={settings?.[key] ?? false}
                disabled={!settings || settingsLoading || Boolean(pending)}
                onClick={() => toggleSetting(key)}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors disabled:opacity-40 ${settings?.[key] ? 'border-primary bg-primary' : 'border-hairline bg-muted/20'}`}
              >
                {pending === `settings:${key}` ? (
                  <Loader2
                    size={13}
                    className="mx-auto animate-spin text-on-primary"
                  />
                ) : (
                  <span
                    className={`size-4 rounded-full bg-canvas shadow-sm transition-transform ${settings?.[key] ? 'translate-x-5' : 'translate-x-1'}`}
                  />
                )}
              </button>
            </label>
          ))}
        </div>
      </section>

      <MemorySessionLearningPanel
        disabled={Boolean(pending)}
        globalLearningEnabled={settings?.learning_enabled}
        refreshKey={managementRefresh}
      />

      <MemorySpeakersPanel
        scopes={memoryScopes.scopes}
        subjects={memoryScopes.subjects}
        loading={memoryScopes.loading}
        error={memoryScopes.error}
        disabled={Boolean(pending)}
        onRefresh={memoryScopes.refresh}
        onSaved={(scope) => {
          memoryScopes.accept(scope);
          void loadList();
        }}
        onSelectScope={(scopeId) =>
          setFilters((previous) => ({ ...previous, scope_id: scopeId }))
        }
      />

      {actionError && !editor && !backfillOpen && !evidenceItem && (
        <p
          role="alert"
          className="rounded-xl border border-error/20 bg-error/5 p-3 text-[12px] text-error"
        >
          {actionError}
        </p>
      )}

      <section className="space-y-3" aria-label={t('memory.itemsTitle')}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-[15px] font-semibold">
            {t('memory.itemsTitle')}
          </h2>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={<History size={13} />}
              disabled={Boolean(pending)}
              onClick={() => {
                setActionError('');
                setLimitBackfillScopes(Boolean(filters.scope_id));
                setBackfillScopeIds(filters.scope_id ? [filters.scope_id] : []);
                setBackfillOpen(true);
              }}
            >
              {t('memory.backfill')}
            </Button>
            <Button
              size="sm"
              icon={<Plus size={13} />}
              disabled={Boolean(pending)}
              onClick={() => {
                setActionError('');
                setEditor({
                  item: null,
                  content: '',
                  kind: 'fact',
                  subjectId: filters.subject_id ?? '',
                });
              }}
            >
              {t('memory.create')}
            </Button>
          </div>
        </div>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setFilters((previous) => ({ ...previous, q: query.trim() }));
          }}
        >
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">{t('memory.search')}</span>
            <Search size={14} className="absolute left-3 top-3 text-muted" />
            <input
              className={`${MEMORY_CONTROL} pl-9`}
              type="search"
              disabled={Boolean(pending)}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('memory.searchPlaceholder')}
            />
          </label>
          <Button
            type="submit"
            variant="secondary"
            disabled={listLoading || Boolean(pending)}
          >
            {t('memory.search')}
          </Button>
        </form>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <label>
            <span className="sr-only">{t('memory.subject')}</span>
            <select
              className={MEMORY_CONTROL}
              disabled={Boolean(pending)}
              value={filters.subject_id ?? ''}
              onChange={(event) =>
                setFilters((previous) => ({
                  ...previous,
                  subject_id: event.target.value,
                }))
              }
            >
              <option value="">{t('memory.allSubjects')}</option>
              {memoryScopes.subjects.map((subject) => (
                <option key={subject.id} value={subject.id}>
                  {subject.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="sr-only">{t('memory.speakers.scope')}</span>
            <select
              className={MEMORY_CONTROL}
              disabled={Boolean(pending) || memoryScopes.loading}
              value={filters.scope_id ?? ''}
              onChange={(event) =>
                setFilters((previous) => ({
                  ...previous,
                  scope_id: event.target.value,
                }))
              }
            >
              <option value="">{t('memory.speakers.allScopes')}</option>
              {memoryScopes.scopes.map((scope) => (
                <option key={scope.id} value={scope.id}>
                  {scope.channel === 'web'
                    ? t('memory.speakers.web')
                    : scope.display_name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="sr-only">{t('memory.status')}</span>
            <select
              className={MEMORY_CONTROL}
              disabled={Boolean(pending)}
              value={filters.status ?? 'active'}
              onChange={(event) =>
                setFilters((previous) => ({
                  ...previous,
                  status: event.target.value as MemoryFilters['status'],
                }))
              }
            >
              <option value="all">{t('memory.allStatuses')}</option>
              {ITEM_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {t(`memory.itemStatuses.${value}`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="sr-only">{t('memory.kind')}</span>
            <select
              className={MEMORY_CONTROL}
              disabled={Boolean(pending)}
              value={filters.kind ?? ''}
              onChange={(event) =>
                setFilters((previous) => ({
                  ...previous,
                  kind: event.target.value as MemoryFilters['kind'],
                }))
              }
            >
              <option value="">{t('memory.allKinds')}</option>
              {MEMORY_KINDS.map((value) => (
                <option key={value} value={value}>
                  {t(`memory.kinds.${value}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
        {listError && (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 rounded-xl border border-error/20 p-3 text-[12px] text-error"
          >
            <span>{listError}</span>
            <Button variant="ghost" size="sm" onClick={() => void loadList()}>
              {t('memory.retry')}
            </Button>
          </div>
        )}
        {listLoading && !list ? (
          <div className="flex justify-center gap-2 py-12 text-[12px] text-muted">
            <Loader2 size={17} className="animate-spin" />
            {t('memory.loading')}
          </div>
        ) : (
          list && (
            <>
              {list.items.length ? (
                <ul
                  className="divide-y divide-hairline overflow-hidden rounded-2xl border border-hairline bg-surface-card/50"
                  aria-busy={listLoading}
                >
                  {list.items.map((item) => (
                    <li key={item.id} className="p-4 sm:p-5">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
                        <span className="font-medium text-ink">
                          {item.subject_name}
                        </span>
                        {item.scope_name && (
                          <span className="text-muted">
                            · {item.scope_name}
                          </span>
                        )}
                        <span>·</span>
                        <span>{t(`memory.kinds.${item.kind}`)}</span>
                        <span
                          className={`rounded-full px-2 py-0.5 ${item.status === 'disputed' ? 'bg-warning/10 text-warning' : item.status === 'active' ? 'bg-primary/8 text-primary' : 'bg-muted/10'}`}
                        >
                          {t(`memory.itemStatuses.${item.status}`)}
                        </span>
                        <span className="ml-auto">
                          {t(`memory.origins.${item.origin}`)}
                        </span>
                      </div>
                      <p className="mt-3 whitespace-pre-wrap break-words text-[14px] leading-7">
                        {item.content}
                      </p>
                      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                        <span className="text-[11px] text-muted">
                          {formatDate(item.observed_at, {
                            dateStyle: 'medium',
                          })}
                        </span>
                        <div className="flex flex-wrap gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setActionError('');
                              setEvidenceItem(item);
                              setEvidence([]);
                              void loadEvidence(item);
                            }}
                          >
                            {t('memory.evidenceCount', {
                              count: formatNumber(item.evidence_count),
                            })}
                          </Button>
                          {item.status !== 'forgotten' && (
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={
                                  Boolean(pending) || item.status !== 'active'
                                }
                                icon={<Pencil size={12} />}
                                onClick={() => {
                                  setActionError('');
                                  setEditor({
                                    item,
                                    content: item.content,
                                    kind: item.kind,
                                    subjectId: item.subject_id,
                                  });
                                }}
                              >
                                {t('memory.edit')}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-error"
                                disabled={Boolean(pending)}
                                loading={pending === `forget:${item.id}`}
                                onClick={() => void forgetItem(item)}
                              >
                                {t('memory.forget')}
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="rounded-2xl border border-dashed border-hairline py-12 text-center">
                  <Brain size={24} className="mx-auto text-muted/50" />
                  <p className="mt-3 text-[13px] text-muted">
                    {t('memory.empty')}
                  </p>
                  <p className="mt-1 px-4 text-[11px] text-muted">
                    {t('memory.emptyHint')}
                  </p>
                </div>
              )}
              {list.next_cursor && (
                <div className="flex justify-center">
                  <Button
                    variant="secondary"
                    loading={listLoading}
                    disabled={Boolean(pending)}
                    onClick={() => void loadList(list.next_cursor ?? undefined)}
                  >
                    {t('memory.loadMore')}
                  </Button>
                </div>
              )}
            </>
          )
        )}
      </section>

      <MemoryJobList
        status={status}
        loading={statusLoading}
        error={statusError}
        pending={pending}
        onRefresh={() => void loadStatus()}
        onJobAction={(job, action) => void jobAction(job, action)}
      />

      <div className="flex flex-wrap items-center justify-between gap-3 text-[12px] text-muted">
        <span>{t('memory.soulNote')}</span>
        <Link href="/persona" className="min-h-9 content-center text-primary">
          {t('memory.openPersona')}
        </Link>
      </div>
      <details className="rounded-xl border border-hairline p-4">
        <summary className="cursor-pointer text-[12px] font-medium text-error">
          {t('memory.clearTitle')}
        </summary>
        <p className="mt-3 text-[11px] leading-5 text-muted">
          {t('memory.clearDescription')}
        </p>
        <label className="mt-3 flex items-start gap-2 text-[12px] leading-5 text-muted">
          <input
            type="checkbox"
            checked={resetContext}
            disabled={Boolean(pending)}
            onChange={(event) => setResetContext(event.target.checked)}
            className="mt-0.5 accent-primary"
          />
          <span>
            {t('memory.resetContext')}
            <span className="mt-1 block text-[11px]">
              {t('memory.resetContextHint')}
            </span>
          </span>
        </label>
        <Button
          variant="danger"
          size="sm"
          className="mt-4"
          loading={pending === 'clear'}
          disabled={Boolean(pending)}
          icon={<Trash2 size={13} />}
          onClick={() => void clearMemory()}
        >
          {t('memory.clear')}
        </Button>
      </details>

      <MemoryEditor
        draft={editor}
        latest={list?.items.find((item) => item.id === editor?.item?.id)}
        subjects={memoryScopes.subjects}
        saving={pending === 'save'}
        error={actionError}
        onChange={(draft) => {
          setActionError('');
          setEditor(draft);
        }}
        onClose={() => {
          if (!pendingRef.current) {
            setEditor(null);
            setActionError('');
          }
        }}
        onSave={() => void saveEditor()}
      />
      <MemoryEvidencePanel
        item={evidenceItem}
        evidence={evidence}
        loading={evidenceLoading}
        error={evidenceError || actionError}
        pending={pending}
        onClose={() => {
          requests.current.get('evidence')?.abort();
          setEvidenceItem(null);
          setActionError('');
        }}
        onRetry={() => {
          setActionError('');
          if (evidenceItem) void loadEvidence(evidenceItem);
        }}
        onExclude={(sourceId) => void excludeSource(sourceId)}
      />

      <BottomSheet
        open={backfillOpen}
        onClose={() => {
          if (!pendingRef.current) setBackfillOpen(false);
        }}
        closeOnOverlay={!pending}
        title={t('memory.backfillTitle')}
        aria-label={t('memory.backfillTitle')}
        footer={
          <div className="flex justify-end gap-2 px-4 py-3 sm:px-6">
            <Button
              variant="secondary"
              disabled={Boolean(pending)}
              onClick={() => setBackfillOpen(false)}
            >
              {t('memory.cancel')}
            </Button>
            <Button
              loading={pending === 'backfill'}
              disabled={
                (backfillScope === 'selected' && !backfillSessions.length) ||
                (limitBackfillScopes && !backfillScopeIds.length) ||
                Boolean(from && to && from > to)
              }
              onClick={() => void startBackfill()}
            >
              {t('memory.startBackfill')}
            </Button>
          </div>
        }
      >
        <div className="space-y-4 p-4 sm:p-6">
          <p className="text-[12px] leading-6 text-muted">
            {t('memory.backfillDescription')}
          </p>
          <label className="block space-y-1.5 text-[12px] text-muted">
            <span>{t('memory.backfillScope')}</span>
            <select
              className={MEMORY_CONTROL}
              value={backfillScope}
              onChange={(event) =>
                setBackfillScope(event.target.value as 'all' | 'selected')
              }
            >
              <option value="all">{t('memory.allConversations')}</option>
              <option value="selected">
                {t('memory.selectedConversations')}
              </option>
            </select>
          </label>
          <fieldset className="space-y-2 rounded-lg border border-hairline p-3">
            <legend className="px-1 text-[12px] text-muted">
              {t('memory.speakers.scope')}
            </legend>
            <label className="flex items-center gap-2 text-[12px]">
              <input
                type="checkbox"
                checked={!limitBackfillScopes}
                disabled={Boolean(pending)}
                onChange={(event) =>
                  setLimitBackfillScopes(!event.target.checked)
                }
                className="accent-primary"
              />
              {t('memory.speakers.allScopes')}
            </label>
            {limitBackfillScopes && (
              <>
                {memoryScopes.loading && (
                  <p className="text-[11px] text-muted">
                    {t('memory.loading')}
                  </p>
                )}
                {memoryScopes.error && (
                  <p role="alert" className="text-[11px] text-error">
                    {memoryScopes.error}
                  </p>
                )}
                <div className="max-h-40 space-y-1 overflow-y-auto">
                  {memoryScopes.scopes.map((scope) => (
                    <label
                      key={scope.id}
                      className="flex items-center gap-2 py-1 text-[12px]"
                    >
                      <input
                        type="checkbox"
                        disabled={Boolean(pending)}
                        checked={backfillScopeIds.includes(scope.id)}
                        onChange={(event) =>
                          setBackfillScopeIds((previous) =>
                            event.target.checked
                              ? [...previous, scope.id]
                              : previous.filter((id) => id !== scope.id),
                          )
                        }
                        className="accent-primary"
                      />
                      <span>
                        {scope.channel === 'web'
                          ? t('memory.speakers.web')
                          : scope.display_name}
                      </span>
                    </label>
                  ))}
                </div>
              </>
            )}
            <p className="text-[11px] leading-5 text-muted">
              {t('memory.speakers.backfillHint')}
            </p>
          </fieldset>
          {backfillScope === 'selected' && (
            <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-hairline p-2">
              {sessionsLoading ? (
                <p className="p-2 text-[12px] text-muted">
                  {t('memory.loading')}
                </p>
              ) : sessions.length ? (
                sessions.map((session) => (
                  <label
                    key={session.id}
                    className="flex items-center gap-2 rounded-md p-2 text-[12px]"
                  >
                    <input
                      type="checkbox"
                      checked={backfillSessions.includes(session.id)}
                      onChange={(event) =>
                        setBackfillSessions((previous) =>
                          event.target.checked
                            ? [...previous, session.id]
                            : previous.filter((id) => id !== session.id),
                        )
                      }
                      className="accent-primary"
                    />
                    <span className="min-w-0 truncate">
                      {session.title || t('memory.untitledConversation')}
                    </span>
                  </label>
                ))
              ) : (
                <p className="p-2 text-[12px] text-muted">
                  {t('memory.noConversations')}
                </p>
              )}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <label className="min-w-0 space-y-1.5 text-[12px] text-muted">
              <span>{t('memory.from')}</span>
              <input
                className={`${MEMORY_CONTROL} min-w-0`}
                type="date"
                value={from}
                max={to || undefined}
                onChange={(event) => setFrom(event.target.value)}
              />
            </label>
            <label className="min-w-0 space-y-1.5 text-[12px] text-muted">
              <span>{t('memory.to')}</span>
              <input
                className={`${MEMORY_CONTROL} min-w-0`}
                type="date"
                value={to}
                min={from || undefined}
                onChange={(event) => setTo(event.target.value)}
              />
            </label>
          </div>
          {from && to && from > to && (
            <p className="text-[12px] text-error">
              {t('memory.invalidDateRange')}
            </p>
          )}
          {actionError && (
            <p role="alert" className="text-[12px] text-error">
              {actionError}
            </p>
          )}
        </div>
      </BottomSheet>
    </div>
  );
}
