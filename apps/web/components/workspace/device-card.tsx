'use client';

import { Circle, Smartphone, Trash2 } from 'lucide-react';

import type { Account } from '@/features/accounts/api';
import { useI18n } from '@/lib/i18n';

/**
 * 微信设备状态卡片。
 *
 * 自定义人格已收敛到用户级 Soul，这里只保留设备状态和解绑操作。
 */
export function DeviceCard({
  account,
  onRemove,
}: {
  account: Account;
  onRemove: () => void;
}) {
  const { formatDate, t } = useI18n();

  return (
    <div className="rounded-2xl border border-hairline/50 bg-[color-mix(in_srgb,var(--color-surface-card)_60%,transparent)] px-4 py-3.5 backdrop-blur-xl transition-colors hover:border-hairline">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="relative shrink-0">
            <div
              className={`flex h-11 w-11 items-center justify-center rounded-xl border ${
                account.enabled
                  ? 'bg-[color-mix(in_srgb,var(--color-success)_10%,transparent)] border-[color-mix(in_srgb,var(--color-success)_20%,transparent)]'
                  : 'border-hairline bg-surface-card'
              }`}
            >
              <Smartphone
                size={18}
                className={account.enabled ? 'text-success' : 'text-muted'}
              />
            </div>
            <Circle
              size={10}
              fill={account.enabled ? 'var(--color-success)' : '#ef4444'}
              className={`absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-surface-card ${
                account.enabled ? 'text-success' : 'text-red-500'
              }`}
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <p className="truncate text-[14px] font-bold leading-tight">
                {account.name}
              </p>
              <span
                className={`shrink-0 whitespace-nowrap rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
                  account.enabled
                    ? 'border-success/20 bg-success/10 text-success'
                    : 'border-red-500/20 bg-red-500/10 text-red-400'
                }`}
              >
                {account.enabled
                  ? t('pages.common.enabled')
                  : t('pages.common.disabled')}
              </span>
            </div>
            <p className="mt-0.5 truncate whitespace-nowrap font-mono text-[11px] text-muted">
              {account.id} ·{' '}
              {t('pages.devices.connectedAt', {
                date: formatDate(account.created_at, {
                  year: 'numeric',
                  month: '2-digit',
                  day: '2-digit',
                }),
              })}
            </p>
          </div>
        </div>
        <button
          onClick={onRemove}
          className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted transition-colors hover:bg-red-500/10 hover:text-red-500"
          aria-label={t('pages.devices.unbind')}
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}
