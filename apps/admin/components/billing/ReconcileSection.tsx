'use client';

import { Loader2, ShieldAlert, Wrench } from 'lucide-react';

/**
 * 管理后台账单页的陈旧计费预留修复操作区。
 */
export function ReconcileSection({
  staleMinutes,
  limit,
  busy,
  message,
  requestIds,
  onStaleMinutesChange,
  onLimitChange,
  onRun,
}: {
  staleMinutes: string;
  limit: string;
  busy: boolean;
  message: string;
  requestIds: string[];
  onStaleMinutesChange: (value: string) => void;
  onLimitChange: (value: string) => void;
  onRun: () => void;
}) {
  return (
    <section className="rounded-xl border border-hairline bg-surface-card p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Wrench size={14} className="text-muted" />
            <h3 className="text-[14px] font-semibold">修复陈旧预留</h3>
          </div>
          <p className="mt-1 text-[12px] leading-5 text-muted">
            手动释放超过陈旧阈值仍冻结中的计费预留，成功后会刷新统计、余额流水和预约列表。
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-[130px_110px_auto] sm:items-end">
          <label className="min-w-0">
            <span className="mb-1 block text-[12px] text-muted">
              陈旧分钟数
            </span>
            <input
              type="number"
              min={1}
              value={staleMinutes}
              onChange={(event) => onStaleMinutesChange(event.target.value)}
              placeholder="后端默认"
              className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-hairline"
            />
          </label>
          <label className="min-w-0">
            <span className="mb-1 block text-[12px] text-muted">处理上限</span>
            <input
              type="number"
              min={1}
              max={1000}
              value={limit}
              onChange={(event) => onLimitChange(event.target.value)}
              placeholder="默认 100"
              className="h-9 w-full rounded-md border border-hairline bg-canvas px-2.5 text-[13px] outline-none focus:border-hairline"
            />
          </label>
          <button
            type="button"
            onClick={onRun}
            disabled={busy}
            className="inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-error px-3 text-[13px] font-medium text-error transition-colors hover:bg-error hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <ShieldAlert size={13} />
            )}
            修复陈旧预留
          </button>
        </div>
      </div>
      {message ? (
        <div className="mt-3 rounded-lg border border-hairline bg-canvas px-3 py-2 text-[12px] text-muted">
          {message}
          {requestIds.length > 0 ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-[12px] text-muted">
                查看 request_id（{requestIds.length}）
              </summary>
              <div className="mt-2 max-h-28 overflow-auto rounded-md bg-surface-card p-2 font-mono text-[11px] leading-5">
                {requestIds.slice(0, 30).map((requestId) => (
                  <div key={requestId} className="break-all">
                    {requestId}
                  </div>
                ))}
              </div>
            </details>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
