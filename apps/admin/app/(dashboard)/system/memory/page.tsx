'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Brain, RefreshCw, RotateCcw, Save } from 'lucide-react';
import type {
  MemoryRuntimePolicy,
  MemoryRuntimeStatusDto,
} from '@fateclaw/contracts/memory';

import {
  AdminField,
  AdminInput,
  AdminPrimaryButton,
  AdminSecondaryButton,
  AdminStatusBadge,
} from '@/components/ui/admin-controls';
import {
  AdminAlert,
  AdminLoadingState,
  AdminPageHeader,
} from '@/components/ui/admin-states';
import {
  createMemoryPolicyDraft,
  MEMORY_POLICY_GROUPS,
  parseMemoryPolicyDraft,
  type MemoryPolicyDraft,
} from '@/components/memory/memory-policy';
import { formatAdminErrorMessage, isAdminConflictError } from '@/lib/admin-api';
import { adminMemoryApi } from '@/lib/memory-api';

const SELECT_CLASS =
  'h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-primary/45 disabled:opacity-50';
const JOB_STATES = {
  pending: '等待处理',
  running: '处理中',
  succeeded: '已完成',
  failed: '失败',
  skipped: '已跳过',
  cancelled: '已取消',
  paused: '已暂停',
};
const JOB_KINDS = {
  extract: '提炼',
  backfill: '历史回填',
};
const PURPOSE_LABELS: Record<string, string> = {
  extract: '提炼',
  extraction: '提炼',
  backfill: '历史回填',
};

export default function MemoryConfigPage() {
  const [status, setStatus] = useState<MemoryRuntimeStatusDto | null>(null);
  const [saved, setSaved] = useState<MemoryRuntimePolicy | null>(null);
  const [draft, setDraft] = useState<MemoryPolicyDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState('');
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);
  const alive = useRef(true);
  const controllers = useRef(new Map<string, AbortController>());
  const actionRunning = useRef(false);

  const request = useCallback((key: string) => {
    controllers.current.get(key)?.abort();
    const controller = new AbortController();
    controllers.current.set(key, controller);
    return controller.signal;
  }, []);

  const accept = useCallback((policy: MemoryRuntimePolicy) => {
    setSaved(policy);
    setDraft(createMemoryPolicyDraft(policy));
    setConflict(false);
  }, []);

  const load = useCallback(
    async (replaceDraft = false) => {
      const signal = request('load');
      setRefreshing(true);
      try {
        const result = await adminMemoryApi.status(signal);
        if (signal.aborted) return;
        setStatus(result);
        setLoadError('');
        if (replaceDraft) {
          accept(result.policy);
          setError('');
        }
      } catch (err) {
        if (!signal.aborted)
          setLoadError(formatAdminErrorMessage(err, '加载记忆配置失败'));
      } finally {
        if (!signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [accept, request],
  );

  useEffect(() => {
    alive.current = true;
    void load(true);
    return () => {
      alive.current = false;
      controllers.current.forEach((controller) => controller.abort());
    };
  }, [load]);

  const pendingJobs = Boolean(
    status?.pending_jobs ||
    status?.recent_jobs.some((job) => job.state === 'running'),
  );
  useEffect(() => {
    if (!pendingJobs) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await load();
      if (!stopped) timer = setTimeout(() => void poll(), 5_000);
    };
    timer = setTimeout(() => void poll(), 5_000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [load, pendingJobs]);

  const parsed = draft ? parseMemoryPolicyDraft(draft) : null;
  const dirty = Boolean(
    saved &&
    draft &&
    JSON.stringify(createMemoryPolicyDraft(saved)) !== JSON.stringify(draft),
  );
  const busy = saving || Boolean(retrying);

  const save = async () => {
    if (!parsed || !dirty || actionRunning.current) return;
    actionRunning.current = true;
    const signal = request('action');
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const policy = await adminMemoryApi.savePolicy(parsed, signal);
      if (signal.aborted) return;
      accept(policy);
      setStatus((previous) => (previous ? { ...previous, policy } : previous));
      setNotice('记忆配置已保存，后续记忆任务和召回使用新配置。');
      void load();
    } catch (err) {
      if (signal.aborted) return;
      if (isAdminConflictError(err)) {
        setConflict(true);
        setError(
          '配置已在其他位置修改。当前草稿已保留，请载入最新配置后重新编辑。',
        );
        void load();
      } else setError(formatAdminErrorMessage(err, '保存记忆配置失败'));
    } finally {
      actionRunning.current = false;
      if (alive.current) setSaving(false);
    }
  };

  const retry = async (id: string) => {
    if (actionRunning.current) return;
    actionRunning.current = true;
    const signal = request('action');
    setRetrying(id);
    setError('');
    setNotice('');
    try {
      const job = await adminMemoryApi.retryJob(id, signal);
      if (signal.aborted) return;
      setStatus((previous) =>
        previous
          ? {
              ...previous,
              recent_jobs: previous.recent_jobs.map((existing) =>
                existing.id === job.id ? job : existing,
              ),
            }
          : previous,
      );
      setNotice('已请求重试，请以任务状态为准。');
      void load();
    } catch (err) {
      if (!signal.aborted)
        setError(formatAdminErrorMessage(err, '重试记忆任务失败'));
    } finally {
      actionRunning.current = false;
      if (alive.current) setRetrying('');
    }
  };

  const patch = (values: Partial<MemoryPolicyDraft>) =>
    setDraft((previous) => (previous ? { ...previous, ...values } : previous));

  return (
    <div className="space-y-5">
      <AdminPageHeader
        icon={Brain}
        title="长期记忆"
        description="管理跨对话记忆的模型、整理任务、召回预算和历史回填。"
        action={
          <AdminSecondaryButton
            icon={RefreshCw}
            disabled={busy || refreshing}
            onClick={() => void load(!draft)}
          >
            {refreshing ? '刷新中' : '刷新状态'}
          </AdminSecondaryButton>
        }
      />
      {loadError && (
        <AdminAlert tone="error">
          <div role="alert">{loadError}</div>
        </AdminAlert>
      )}
      {error && (
        <AdminAlert tone="error">
          <div role="alert">{error}</div>
          {conflict && (
            <AdminSecondaryButton
              className="mt-3"
              disabled={busy || refreshing}
              onClick={() => void load(true)}
            >
              载入最新配置
            </AdminSecondaryButton>
          )}
        </AdminAlert>
      )}
      {notice && <AdminAlert tone="success">{notice}</AdminAlert>}
      {loading ? (
        <AdminLoadingState />
      ) : (
        draft &&
        status && (
          <>
            <section className="rounded-xl border border-hairline bg-surface-card p-4 sm:p-5">
              <h2 className="text-[15px] font-medium">整理与检索状态</h2>
              <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
                {[
                  ['有效记忆', status.active_items],
                  ['已索引', status.indexed_items],
                  ['等待处理', status.pending_jobs],
                  ['失败任务', status.failed_jobs],
                ].map(([label, count]) => (
                  <div key={label}>
                    <dt className="text-[11px] text-muted">{label}</dt>
                    <dd className="mt-1 text-xl tabular-nums">
                      {Number(count).toLocaleString()}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>

            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <fieldset disabled={busy} className="space-y-4">
                <section className="rounded-xl border border-hairline bg-surface-card p-4 sm:p-5">
                  <h2 className="text-[15px] font-medium">服务开关</h2>
                  <div className="mt-4 space-y-4">
                    <label className="flex items-start gap-3 text-[13px]">
                      <input
                        type="checkbox"
                        checked={draft.enabled}
                        onChange={(event) =>
                          patch({ enabled: event.target.checked })
                        }
                        className="mt-0.5 size-4 accent-primary"
                      />
                      <span>
                        启用长期记忆
                        <span className="mt-1 block text-[12px] text-muted">
                          控制记忆后台处理与召回能力。
                        </span>
                      </span>
                    </label>
                    <label className="flex items-start gap-3 text-[13px]">
                      <input
                        type="checkbox"
                        checked={draft.default_learning_enabled}
                        onChange={(event) =>
                          patch({
                            default_learning_enabled: event.target.checked,
                          })
                        }
                        className="mt-0.5 size-4 accent-primary"
                      />
                      <span>
                        新用户默认开启自动学习
                        <span className="mt-1 block text-[12px] text-muted">
                          用户可以在自己的记忆页单独调整。
                        </span>
                      </span>
                    </label>
                  </div>
                </section>
                <section className="rounded-xl border border-hairline bg-surface-card p-4 sm:p-5">
                  <h2 className="text-[15px] font-medium">记忆模型</h2>
                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    <AdminField label="提炼模型">
                      <select
                        className={SELECT_CLASS}
                        value={draft.extraction_model_id ?? ''}
                        onChange={(event) =>
                          patch({
                            extraction_model_id: event.target.value || null,
                          })
                        }
                      >
                        <option value="">当前主模型</option>
                        {draft.extraction_model_id &&
                          !status.model_choices.some(
                            (choice) => choice.id === draft.extraction_model_id,
                          ) && (
                            <option value={draft.extraction_model_id}>
                              当前配置（已不可用）
                            </option>
                          )}
                        {status.model_choices.map((choice) => (
                          <option key={choice.id} value={choice.id}>
                            {choice.display_name} · {choice.model_name}
                          </option>
                        ))}
                      </select>
                    </AdminField>
                  </div>
                </section>
                {MEMORY_POLICY_GROUPS.map((group) => (
                  <section
                    key={group.title}
                    className="rounded-xl border border-hairline bg-surface-card p-4 sm:p-5"
                  >
                    <h2 className="text-[15px] font-medium">{group.title}</h2>
                    <div className="mt-4 grid gap-4 sm:grid-cols-2">
                      {group.fields.map(([key, label, hint]) => (
                        <AdminField key={key} label={label} hint={hint}>
                          <AdminInput
                            type="number"
                            step={1}
                            min={1}
                            required
                            value={draft[key]}
                            onChange={(event) =>
                              patch({ [key]: event.target.value })
                            }
                          />
                        </AdminField>
                      ))}
                    </div>
                  </section>
                ))}
              </fieldset>
              {!parsed && (
                <p className="text-[12px] text-error">
                  数值必须为正整数。
                </p>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <AdminPrimaryButton
                  type="submit"
                  icon={Save}
                  loading={saving}
                  disabled={busy || !parsed || !dirty || conflict}
                >
                  保存记忆配置
                </AdminPrimaryButton>
                <AdminSecondaryButton
                  disabled={busy || !dirty}
                  onClick={() => {
                    if (conflict) void load(true);
                    else {
                      if (saved) accept(saved);
                      setError('');
                    }
                  }}
                >
                  取消修改
                </AdminSecondaryButton>
                <span className="text-[11px] text-muted">
                  {dirty
                    ? '有未保存修改'
                    : `已保存 · 版本 ${saved?.revision ?? ''}`}
                </span>
              </div>
            </form>

            <section className="rounded-xl border border-hairline bg-surface-card p-4 sm:p-5">
              <h2 className="text-[15px] font-medium">今日模型用量</h2>
              {status.usage_today.length ? (
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-left text-[12px]">
                    <thead className="text-[11px] text-muted">
                      <tr>
                        <th className="pb-3 font-normal">用途</th>
                        <th className="pb-3 text-right font-normal">
                          调用次数
                        </th>
                        <th className="pb-3 text-right font-normal">
                          输入 token
                        </th>
                        <th className="pb-3 text-right font-normal">
                          输出 token
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {status.usage_today.map((usage) => (
                        <tr
                          key={usage.purpose}
                          className="border-t border-hairline"
                        >
                          <td className="py-3">
                            {PURPOSE_LABELS[usage.purpose] ?? usage.purpose}
                          </td>
                          <td className="text-right tabular-nums">
                            {usage.calls.toLocaleString()}
                          </td>
                          <td className="text-right tabular-nums">
                            {usage.input_tokens.toLocaleString()}
                          </td>
                          <td className="text-right tabular-nums">
                            {usage.output_tokens.toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="mt-3 text-[12px] text-muted">
                  今日暂无记忆模型调用记录。
                </p>
              )}
            </section>

            <section className="rounded-xl border border-hairline bg-surface-card p-4 sm:p-5">
              <h2 className="text-[15px] font-medium">最近任务</h2>
              <p className="mt-2 text-[11px] leading-5 text-muted">
                等待处理的任务尚未完成提炼或保存。失败任务可在修正配置后重试。
              </p>
              {status.recent_jobs.length ? (
                <ul className="mt-3 divide-y divide-hairline">
                  {status.recent_jobs.map((job) => (
                    <li
                      key={job.id}
                      className="flex flex-wrap items-center gap-3 py-3 text-[12px]"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span>{JOB_KINDS[job.kind]}</span>
                          <AdminStatusBadge
                            tone={
                              job.state === 'failed'
                                ? 'error'
                                : job.state === 'succeeded'
                                  ? 'success'
                                  : 'neutral'
                            }
                          >
                            {JOB_STATES[job.state]}
                          </AdminStatusBadge>
                        </div>
                        <p className="mt-1 break-all text-[11px] text-muted">
                          {job.id} · 已处理{' '}
                          {job.processed_count.toLocaleString()}
                          {job.total_count === null
                            ? ''
                            : ` / ${job.total_count.toLocaleString()}`}{' '}
                          · 尝试 {job.attempts}
                          {job.error_code && (
                            <span className="ml-2 text-error">
                              {job.error_code}
                            </span>
                          )}
                        </p>
                      </div>
                      {job.state === 'failed' && (
                        <AdminSecondaryButton
                          icon={RotateCcw}
                          disabled={busy}
                          onClick={() => void retry(job.id)}
                        >
                          {retrying === job.id ? '重试中' : '重试'}
                        </AdminSecondaryButton>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-[12px] text-muted">
                  暂无后台记忆任务。
                </p>
              )}
            </section>
          </>
        )
      )}
    </div>
  );
}
