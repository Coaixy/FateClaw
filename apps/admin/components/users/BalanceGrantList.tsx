'use client';

import type { AdminBalanceGrant } from '@/lib/admin-api';
import { formatCoins } from '@/lib/soft-currency';
import { Loader2 } from 'lucide-react';

const BALANCE_GRANT_STATUS_LABELS: Record<AdminBalanceGrant['status'], string> = {
  active: '可用',
  exhausted: '已耗尽',
  expired: '已过期',
  revoked: '已撤销',
};

function formatDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * 展示用户赠送余额批次，帮助管理员确认来源、剩余、状态和过期时间。
 */
export function BalanceGrantList({
  grants,
  loading,
  includeExhausted,
  onIncludeExhaustedChange,
}: {
  grants: AdminBalanceGrant[];
  loading: boolean;
  includeExhausted: boolean;
  onIncludeExhaustedChange: (next: boolean) => void;
}) {
  return (
    <div className="mt-4 border-t border-hairline pt-3">
      <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-[12px] font-medium text-muted">赠送余额批次</div>
        <label className="inline-flex cursor-pointer items-center gap-2 text-[12px] text-muted">
          <input
            type="checkbox"
            checked={includeExhausted}
            onChange={(event) => onIncludeExhaustedChange(event.target.checked)}
            className="h-3.5 w-3.5 accent-primary"
          />
          显示已耗尽和已过期批次
        </label>
      </div>
      {loading ? (
        <div className="flex items-center gap-2 py-3 text-[12px] text-muted">
          <Loader2 size={13} className="animate-spin" />
          加载批次中
        </div>
      ) : grants.length > 0 ? (
        <div className="divide-y divide-hairline rounded-lg border border-hairline">
          {grants.map((grant) => (
            <div
              key={grant.id}
              className="grid gap-2 px-3 py-2 text-[12px] md:grid-cols-[minmax(0,1fr)_120px_120px]"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{grant.source}</span>
                  <span className="rounded-md border border-hairline bg-canvas px-1.5 py-0.5 text-[11px] text-muted">
                    {BALANCE_GRANT_STATUS_LABELS[grant.status]}
                  </span>
                </div>
                <div className="mt-1 break-words text-[11px] text-muted">
                  {grant.note || '无备注'} · 过期 {formatDate(grant.expires_at)} ·
                  发放人 {grant.granted_by || '—'}
                </div>
              </div>
              <div className="tabular-nums">
                总额 {formatCoins(grant.amount_coins)}
              </div>
              <div className="tabular-nums text-muted md:text-right">
                剩余 {formatCoins(grant.remaining_coins)}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="py-3 text-[13px] text-muted">暂无赠送余额批次</p>
      )}
    </div>
  );
}
