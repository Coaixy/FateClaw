'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  admin,
  formatAdminErrorMessage,
  type AdminSystemConfigOverview,
} from '@/lib/admin-api';
import { AuditLogViewer } from '@/components/system/AuditLogViewer';
import { RefreshCw, SlidersHorizontal } from 'lucide-react';
import { RuntimeConfigPanel } from '../model-provider-panels';

/**
 * 后台「运行时配置」独立页面。
 *
 * 从原「模型配置」页拆出 Agent 运行时策略(并发、单请求超时、常驻 runtime、Pi session、
 * Skill 限制),并附配置变更审计(分页)。运行时参数会注入 agent-runtime 进程。
 */
export default function AdminRuntimeConfigPage() {
  const [overview, setOverview] = useState<AdminSystemConfigOverview | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setOverview(await admin.systemConfig());
    } catch (err) {
      setError(formatAdminErrorMessage(err, '加载失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-transparent" />
      </div>
    );
  }

  if (!overview) {
    return (
      <div className="py-20 text-center text-[13px] text-error">
        {error || '加载失败'}
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <SlidersHorizontal size={16} className="text-muted" />
            <h2 className="text-lg font-semibold">运行时配置</h2>
          </div>
          <p className="mt-1 text-[13px] leading-6 text-muted">
            控制 Agent 并发、单请求超时、常驻 runtime、Pi session 健康与 Skill
            限制。并发与超时改动对之后新拉起的 agent-runtime 生效。
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="inline-flex h-10 items-center gap-2 self-start rounded-lg border border-hairline px-3 text-[13px] text-muted hover:text-ink"
          title="刷新"
        >
          <RefreshCw size={13} />
          刷新
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-error/30 bg-error/8 px-4 py-3 text-[13px] text-error">
          {error}
        </div>
      )}

      <RuntimeConfigPanel
        runtime={overview.runtime}
        providers={overview.providers}
        busy={busy}
        onSave={async (config) => {
          setBusy(true);
          setError('');
          try {
            await admin.updateRuntimeConfig(config);
            await load();
          } catch (err) {
            setError(formatAdminErrorMessage(err, '保存失败'));
          } finally {
            setBusy(false);
          }
        }}
      />

      <AuditLogViewer />
    </div>
  );
}
