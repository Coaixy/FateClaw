'use client';

import { Suspense, useEffect, useReducer, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Archive,
  ArrowLeft,
  CalendarDays,
  ClipboardList,
  Loader2,
  MapPin,
  MessageCircle,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  Users,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { chatSessionsApi, type ChatSession } from '@/features/chat/api';
import {
  clientFollowUpsApi,
  clientProfilesApi,
  type ClientFollowUp,
  type ClientProfile,
  type ClientStatus,
} from '@/features/chat/client-profiles-api';
import { useAuth } from '@/features/auth/hooks/use-auth';
import { useI18n } from '@/lib/i18n';
import { useConfirm } from '@/lib/use-confirm';

/** 客户状态徽章样式（与列表页保持一致：vip→primary、待跟进→warning、已完成→success）。 */
const STATUS_BADGE_CLASS: Record<ClientStatus, string> = {
  vip: 'border-primary/40 bg-primary/10 text-primary',
  follow_up: 'border-warning/40 bg-warning/10 text-warning',
  done: 'border-success/40 bg-success/10 text-success',
};

const STATUS_LABEL_KEY: Record<ClientStatus, string> = {
  vip: 'clients.status.vip',
  follow_up: 'clients.status.followUp',
  done: 'clients.status.done',
};

/** 客户详情页的服务端数据切片:档案、会话、跟进记录及其加载生命周期。 */
type ClientDataState = {
  profile: ClientProfile | null;
  sessions: ChatSession[];
  followUps: ClientFollowUp[];
  loading: boolean;
  error: string;
};

/** {@link ClientDataState} 的动作集合。 */
type ClientDataAction =
  | { type: 'load-start' }
  | {
      type: 'load-success';
      profile: ClientProfile;
      sessions: ChatSession[];
      followUps: ClientFollowUp[];
    }
  | { type: 'load-error'; message: string }
  | { type: 'add-follow-up'; followUp: ClientFollowUp }
  | { type: 'remove-follow-up'; id: string }
  | { type: 'replace-session'; session: ChatSession };

const initialClientData: ClientDataState = {
  profile: null,
  sessions: [],
  followUps: [],
  loading: true,
  error: '',
};

/**
 * 客户详情数据 reducer。
 *
 * 把档案 / 会话 / 跟进记录及其加载态合并为单一切片:加载流程用
 * load-start → load-success/load-error 一次性切换,避免散落在 effect 里的级联 setState;
 * 跟进的增删与会话恢复也在此切片内就地更新。
 */
function clientDataReducer(
  state: ClientDataState,
  action: ClientDataAction,
): ClientDataState {
  switch (action.type) {
    case 'load-start':
      return { ...state, loading: true, error: '' };
    case 'load-success':
      return {
        profile: action.profile,
        sessions: action.sessions,
        followUps: action.followUps,
        loading: false,
        error: '',
      };
    case 'load-error':
      return { ...state, loading: false, error: action.message };
    case 'add-follow-up':
      return { ...state, followUps: [action.followUp, ...state.followUps] };
    case 'remove-follow-up':
      return {
        ...state,
        followUps: state.followUps.filter((item) => item.id !== action.id),
      };
    case 'replace-session':
      return {
        ...state,
        sessions: state.sessions.map((item) =>
          item.id === action.session.id ? action.session : item,
        ),
      };
    default:
      return state;
  }
}

/** 「新增跟进」表单切片:输入内容、提交中状态与错误信息。 */
type FollowUpFormState = {
  note: string;
  submitting: boolean;
  error: string;
};

/** {@link FollowUpFormState} 的动作集合。 */
type FollowUpFormAction =
  | { type: 'set-note'; value: string }
  | { type: 'submit-start' }
  | { type: 'submit-success' }
  | { type: 'set-error'; message: string };

const initialFollowUpForm: FollowUpFormState = {
  note: '',
  submitting: false,
  error: '',
};

/**
 * 跟进表单 reducer。
 *
 * 新增提交用 submit-start → submit-success 串起;新增失败与删除失败统一走 set-error
 * (set-error 也负责清空提交态),删除前清错误则 dispatch 一条空 message 的 set-error。
 */
function followUpFormReducer(
  state: FollowUpFormState,
  action: FollowUpFormAction,
): FollowUpFormState {
  switch (action.type) {
    case 'set-note':
      return { ...state, note: action.value };
    case 'submit-start':
      return { ...state, submitting: true, error: '' };
    case 'submit-success':
      return { note: '', submitting: false, error: '' };
    case 'set-error':
      return { ...state, submitting: false, error: action.message };
    default:
      return state;
  }
}

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
  const { confirm } = useConfirm();

  // 服务端数据与跟进表单各自合并为一个 reducer 切片;再按原字段名解构,使下方 JSX/逻辑零改动。
  const [data, dispatchData] = useReducer(clientDataReducer, initialClientData);
  const [form, dispatchForm] = useReducer(
    followUpFormReducer,
    initialFollowUpForm,
  );
  const { profile, sessions, loading, error, followUps } = data;
  const { note: newNote, submitting, error: followUpError } = form;
  // 已归档会话的就地恢复:restoringSessionId 既做并发互斥,也驱动当前条目的加载态。
  const [restoringSessionId, setRestoringSessionId] = useState('');
  const [restoreError, setRestoreError] = useState('');

  useEffect(() => {
    if (!user || !clientId) {
      return;
    }
    let cancelled = false;
    dispatchData({ type: 'load-start' });
    Promise.all([
      clientProfilesApi.get(clientId),
      chatSessionsApi.byClient(clientId),
      clientFollowUpsApi.list(clientId),
    ])
      .then(([loadedProfile, loadedSessions, loadedFollowUps]) => {
        if (cancelled) return;
        dispatchData({
          type: 'load-success',
          profile: loadedProfile,
          sessions: loadedSessions,
          followUps: loadedFollowUps.follow_ups,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        dispatchData({
          type: 'load-error',
          message:
            err instanceof Error ? err.message : t('clients.detail.loadFailed'),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [user, clientId, t]);

  // 提交一条跟进记录：成功后清空输入并把新记录插到时间线顶部。
  const handleAddFollowUp = async () => {
    const content = newNote.trim();
    if (!content || submitting) return;
    dispatchForm({ type: 'submit-start' });
    try {
      const created = await clientFollowUpsApi.create(clientId, { content });
      dispatchData({ type: 'add-follow-up', followUp: created });
      dispatchForm({ type: 'submit-success' });
    } catch (err) {
      dispatchForm({
        type: 'set-error',
        message:
          err instanceof Error
            ? err.message
            : t('clients.detail.followUps.addFailed'),
      });
    }
  };

  // 软删除一条跟进记录，先弹自定义确认框（危险态）再删。
  const handleDeleteFollowUp = async (id: string) => {
    const ok = await confirm({
      title: t('clients.detail.followUps.deleteTitle'),
      message: t('clients.detail.followUps.deleteConfirm'),
      confirmLabel: t('clients.detail.followUps.delete'),
      variant: 'danger',
    });
    if (!ok) return;
    dispatchForm({ type: 'set-error', message: '' });
    try {
      await clientFollowUpsApi.delete(clientId, id);
      dispatchData({ type: 'remove-follow-up', id });
    } catch (err) {
      dispatchForm({
        type: 'set-error',
        message:
          err instanceof Error
            ? err.message
            : t('clients.detail.followUps.deleteFailed'),
      });
    }
  };

  // 就地恢复一条已归档会话:确认后调用 restore,成功则把该会话替换为恢复后的版本
  // (deleted_at 置空),卡片随之从静态展示切回可点击的活跃样式;无需离开本页去归档页。
  const handleRestoreSession = async (sessionId: string) => {
    if (restoringSessionId) return;
    const ok = await confirm({
      title: t('clients.detail.restoreTitle'),
      message: t('clients.detail.restoreConfirm'),
      confirmLabel: t('clients.detail.restore'),
    });
    if (!ok) return;
    setRestoringSessionId(sessionId);
    setRestoreError('');
    try {
      const restored = await chatSessionsApi.restore(sessionId);
      dispatchData({ type: 'replace-session', session: restored });
    } catch (err) {
      setRestoreError(
        err instanceof Error ? err.message : t('clients.detail.restoreFailed'),
      );
    } finally {
      setRestoringSessionId('');
    }
  };

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
            <header className="rounded-2xl border border-hairline bg-surface-raised p-5 shadow-raised">
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
                  className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full btn-tactile-primary px-4 text-[13px] font-medium text-on-primary transition-opacity hover:opacity-90"
                >
                  <Sparkles size={14} />
                  {t('clients.card.startReading')}
                </button>
              </div>
            </header>

            {/* 跟进记录:可追加的客户服务时间线 */}
            <section className="space-y-3">
              <h2 className="px-0.5 text-[13px] font-semibold text-ink">
                {t('clients.detail.followUps.title')}
                {followUps.length > 0 && (
                  <span className="ml-1.5 text-[12px] font-normal text-muted">
                    {followUps.length}
                  </span>
                )}
              </h2>

              {/* 追加输入框 */}
              <div className="rounded-2xl border border-hairline bg-surface-raised p-3">
                <textarea
                  value={newNote}
                  onChange={(event) =>
                    dispatchForm({ type: 'set-note', value: event.target.value })
                  }
                  placeholder={t('clients.detail.followUps.placeholder')}
                  rows={2}
                  className="w-full resize-none bg-transparent text-[13px] leading-relaxed text-ink placeholder:text-muted/60 focus:outline-none"
                />
                <div className="mt-2 flex justify-end">
                  <button
                    type="button"
                    onClick={handleAddFollowUp}
                    disabled={!newNote.trim() || submitting}
                    className="inline-flex h-8 items-center gap-1.5 rounded-full btn-tactile-primary px-3.5 text-[12px] font-medium text-on-primary transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {submitting ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Plus size={13} />
                    )}
                    {submitting
                      ? t('clients.detail.followUps.adding')
                      : t('clients.detail.followUps.add')}
                  </button>
                </div>
              </div>

              {followUpError && (
                <p className="px-0.5 text-[12px] text-error">
                  {followUpError}
                </p>
              )}

              {/* 时间线列表（倒序,最新在前） */}
              {followUps.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-hairline py-10 text-center text-[12px] text-muted">
                  {t('clients.detail.followUps.empty')}
                </div>
              ) : (
                <div className="space-y-2">
                  {followUps.map((item) => (
                    <div
                      key={item.id}
                      className="group flex items-start gap-3 rounded-2xl border border-hairline bg-surface-raised px-3.5 py-3"
                    >
                      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <ClipboardList size={13} strokeWidth={1.8} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink">
                          {item.content}
                        </p>
                        <p className="mt-1 text-[11px] text-muted">
                          {formatDate(item.created_at, {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleDeleteFollowUp(item.id)}
                        aria-label={t('clients.detail.followUps.delete')}
                        className="shrink-0 rounded-md p-1 text-muted/50 opacity-0 transition-all hover:text-error group-hover:opacity-100"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* 断卦历史:活跃 + 已归档统一列出 */}
            <section className="space-y-3">
              <h2 className="px-0.5 text-[13px] font-semibold text-ink">
                {t('clients.detail.sessionsTitle')}
                <span className="ml-1.5 text-[12px] font-normal text-muted">
                  {sessions.length}
                </span>
              </h2>

              {restoreError && (
                <p className="px-0.5 text-[12px] text-error">
                  {restoreError}
                </p>
              )}

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

                    // 活跃会话可直接打开;已归档会话展示并提供就地"恢复"按钮。
                    return archived ? (
                      <div
                        key={session.id}
                        className="flex items-center gap-3 rounded-2xl border border-hairline bg-surface-card/60 px-3.5 py-3"
                      >
                        {body}
                        <button
                          type="button"
                          onClick={() => void handleRestoreSession(session.id)}
                          disabled={Boolean(restoringSessionId)}
                          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-primary/25 bg-primary/10 px-3 text-[12px] font-medium text-primary transition-colors hover:bg-primary/15 disabled:cursor-wait disabled:opacity-60"
                        >
                          {restoringSessionId === session.id ? (
                            <Loader2 size={13} className="animate-spin" />
                          ) : (
                            <RotateCcw size={13} strokeWidth={1.8} />
                          )}
                          {restoringSessionId === session.id
                            ? t('clients.detail.restoring')
                            : t('clients.detail.restore')}
                        </button>
                      </div>
                    ) : (
                      <Link
                        key={session.id}
                        href={`/ai-chat?sid=${encodeURIComponent(session.id)}`}
                        className="flex items-center gap-3 rounded-2xl border border-hairline bg-surface-raised px-3.5 py-3 transition-colors hover:border-primary/30"
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
