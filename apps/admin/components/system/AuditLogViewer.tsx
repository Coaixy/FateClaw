'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  admin,
  formatAdminErrorMessage,
  type AdminConfigAuditLog,
} from '@/lib/admin-api';
import { ChevronLeft, ChevronRight, FileText, RefreshCw } from 'lucide-react';

const SENSITIVE_KEY_PATTERN =
  /(api[_-]?key|secret|token|private[_-]?key|password|credential)/i;

const DEFAULT_PAGE_SIZE = 20;

function redactSensitiveJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      SENSITIVE_KEY_PATTERN.test(key) ? '******' : redactSensitiveJson(entry),
    ]),
  );
}

function stringifyAuditJson(value: unknown) {
  if (value == null) return 'null';
  return JSON.stringify(redactSensitiveJson(value), null, 2);
}

function AuditLogCard({ log }: { log: AdminConfigAuditLog }) {
  return (
    <article className="rounded-xl border border-hairline bg-surface-card p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-md border border-hairline bg-canvas px-2 py-0.5 text-[11px] text-muted">
              {log.target_type}
            </span>
            <span className="text-[13px] font-semibold">{log.action}</span>
            <span className="break-all font-mono text-[12px] text-muted">
              {log.target_key}
            </span>
          </div>
          <div className="mt-1 text-[11px] text-muted">
            actor {log.actor_user_id || 'system'}
          </div>
        </div>
        <time className="shrink-0 text-[11px] text-muted">
          {new Date(log.created_at).toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          })}
        </time>
      </div>

      <details className="mt-3 rounded-lg border border-hairline bg-canvas px-3 py-2">
        <summary className="cursor-pointer text-[12px] font-medium text-muted">
          查看 before / after JSON
        </summary>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <div className="min-w-0">
            <div className="mb-1 text-[11px] text-muted">before</div>
            <pre className="max-h-72 overflow-auto rounded-md bg-surface-card p-3 text-[11px] leading-5">
              {stringifyAuditJson(log.before_json)}
            </pre>
          </div>
          <div className="min-w-0">
            <div className="mb-1 text-[11px] text-muted">after</div>
            <pre className="max-h-72 overflow-auto rounded-md bg-surface-card p-3 text-[11px] leading-5">
              {stringifyAuditJson(log.after_json)}
            </pre>
          </div>
        </div>
      </details>
    </article>
  );
}

/**
 * 配置变更审计日志,独立分页拉取(不再依赖一次性总览返回的固定 50 条)。
 * 渲染前遮蔽敏感 JSON 字段。
 *
 * @param pageSize 每页条数,默认 20。
 */
export function AuditLogViewer({
  pageSize = DEFAULT_PAGE_SIZE,
}: {
  pageSize?: number;
}) {
  // page 为 0-based 页码
  const [page, setPage] = useState(0);
  const [logs, setLogs] = useState<AdminConfigAuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(
    async (targetPage: number) => {
      setLoading(true);
      setError('');
      try {
        const data = await admin.configAuditLogs({
          offset: targetPage * pageSize,
          limit: pageSize,
        });
        setLogs(data.items);
        setTotal(data.total);
      } catch (err) {
        setError(formatAdminErrorMessage(err, '加载审计日志失败'));
      } finally {
        setLoading(false);
      }
    },
    [pageSize],
  );

  useEffect(() => {
    void load(page);
  }, [load, page]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const canPrev = page > 0 && !loading;
  const canNext = page + 1 < totalPages && !loading;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <FileText size={15} className="text-muted" />
            <h3 className="text-[15px] font-semibold">配置变更审计</h3>
          </div>
          <p className="mt-1 text-[12px] leading-5 text-muted">
            记录模型、价格和运行时策略的后台配置变更,不包含对话日志。
            {total > 0 ? ` 共 ${total} 条。` : ''}
          </p>
        </div>
        <button
          onClick={() => void load(page)}
          disabled={loading}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-hairline px-3 text-[12px] text-muted hover:text-ink disabled:opacity-50"
          title="刷新"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          刷新
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-error/30 bg-error/8 px-4 py-3 text-[13px] text-error">
          {error}
        </div>
      )}

      {loading && logs.length === 0 ? (
        <div className="flex justify-center py-10">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-transparent" />
        </div>
      ) : logs.length === 0 ? (
        <div className="rounded-lg border border-hairline bg-surface-card px-4 py-6 text-[13px] text-muted">
          暂无配置审计日志
        </div>
      ) : (
        <div className="space-y-2">
          {logs.map((log) => (
            <AuditLogCard key={log.id} log={log} />
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between gap-3 pt-1">
          <button
            onClick={() => setPage((value) => Math.max(0, value - 1))}
            disabled={!canPrev}
            className="inline-flex h-9 items-center gap-1 rounded-lg border border-hairline px-3 text-[12px] text-muted hover:text-ink disabled:opacity-40"
          >
            <ChevronLeft size={14} />
            上一页
          </button>
          <span className="text-[12px] text-muted">
            第 {page + 1} / {totalPages} 页
          </span>
          <button
            onClick={() => setPage((value) => value + 1)}
            disabled={!canNext}
            className="inline-flex h-9 items-center gap-1 rounded-lg border border-hairline px-3 text-[12px] text-muted hover:text-ink disabled:opacity-40"
          >
            下一页
            <ChevronRight size={14} />
          </button>
        </div>
      )}
    </section>
  );
}
