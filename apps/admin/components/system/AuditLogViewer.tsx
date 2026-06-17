'use client';

import type { AdminConfigAuditLog } from '@/lib/admin-api';
import { FileText } from 'lucide-react';

const SENSITIVE_KEY_PATTERN =
  /(api[_-]?key|secret|token|private[_-]?key|password|credential)/i;

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

/**
 * 展示模型配置变更审计日志，并在渲染前遮蔽敏感 JSON 字段。
 */
export function AuditLogViewer({ logs }: { logs: AdminConfigAuditLog[] }) {
  return (
    <section className="space-y-3">
      <div>
        <div className="flex items-center gap-2">
          <FileText size={15} className="text-muted" />
          <h3 className="text-[15px] font-semibold">配置变更审计</h3>
        </div>
        <p className="mt-1 text-[12px] leading-5 text-muted">
          记录模型、价格和运行时策略的后台配置变更，不包含对话日志。
        </p>
      </div>

      {logs.length === 0 ? (
        <div className="rounded-lg border border-hairline bg-surface-card px-4 py-6 text-[13px] text-muted">
          暂无配置审计日志
        </div>
      ) : (
        <div className="space-y-2">
          {logs.map((log) => (
            <article
              key={log.id}
              className="rounded-xl border border-hairline bg-surface-card p-4"
            >
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-md border border-hairline bg-canvas px-2 py-0.5 text-[11px] text-muted">
                      {log.target_type}
                    </span>
                    <span className="text-[13px] font-semibold">
                      {log.action}
                    </span>
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
          ))}
        </div>
      )}
    </section>
  );
}
