'use client';

import { useEffect, useState } from 'react';
import type { AdminRechargePaymentConfig } from '@/lib/admin-api';
import { CreditCard, Loader2, Save } from 'lucide-react';

type RechargeDraft = Omit<AdminRechargePaymentConfig, 'updated_at'>;

function draftFromConfig(
  config: AdminRechargePaymentConfig | null,
): RechargeDraft {
  return config
    ? {
        enabled: config.enabled,
        min_yuan: config.min_yuan,
        max_yuan: config.max_yuan,
        epay_url_prefix: config.epay_url_prefix,
        epay_platform_id: config.epay_platform_id,
        epay_merchant_private_key: config.epay_merchant_private_key,
        epay_platform_public_key: config.epay_platform_public_key,
        epay_merchant_key: config.epay_merchant_key,
        notify_url: config.notify_url,
        return_url: config.return_url,
      }
    : {
        enabled: false,
        min_yuan: '1.00',
        max_yuan: '1000.00',
        epay_url_prefix: '',
        epay_platform_id: null,
        epay_merchant_private_key: '',
        epay_platform_public_key: '',
        epay_merchant_key: '',
        notify_url: '',
        return_url: '',
      };
}

export function RechargeConfigPanel({
  config,
  busy,
  onSave,
}: {
  config: AdminRechargePaymentConfig | null;
  busy: boolean;
  onSave: (draft: RechargeDraft) => Promise<void>;
}) {
  const [draft, setDraft] = useState<RechargeDraft>(() =>
    draftFromConfig(config),
  );

  useEffect(() => {
    if (!config) return;
    setDraft(draftFromConfig(config));
  }, [config]);

  if (!config) {
    return (
      <div className="rounded-lg border border-hairline bg-surface-card p-4 text-[13px] text-muted">
        充值配置加载中...
      </div>
    );
  }

  const updateDraft = <TKey extends keyof RechargeDraft>(
    key: TKey,
    value: RechargeDraft[TKey],
  ) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="rounded-lg border border-hairline bg-surface-card p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold">
            <CreditCard size={15} className="text-muted" />
            充值配置
          </div>
          <div className="mt-1 text-[12px] leading-5 text-muted">
            易支付参数保存在数据库，钱包充值下单和回调都读取这里的配置。
          </div>
        </div>
        <label className="inline-flex items-center gap-2 text-[13px] text-muted">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => updateDraft('enabled', event.target.checked)}
            className="h-4 w-4 accent-primary"
          />
          开启充值
        </label>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <label className="space-y-1.5">
          <div className="text-[12px] font-medium text-muted">
            最低金额（元）
          </div>
          <input
            value={draft.min_yuan}
            onChange={(event) => updateDraft('min_yuan', event.target.value)}
            inputMode="decimal"
            className="h-11 w-full rounded-lg border border-hairline bg-canvas px-3 text-sm focus:border-hairline focus:outline-none"
          />
        </label>
        <label className="space-y-1.5">
          <div className="text-[12px] font-medium text-muted">
            最高金额（元）
          </div>
          <input
            value={draft.max_yuan}
            onChange={(event) => updateDraft('max_yuan', event.target.value)}
            inputMode="decimal"
            className="h-11 w-full rounded-lg border border-hairline bg-canvas px-3 text-sm focus:border-hairline focus:outline-none"
          />
        </label>
        <label className="space-y-1.5 lg:col-span-2">
          <div className="text-[12px] font-medium text-muted">
            易支付网关地址
          </div>
          <input
            value={draft.epay_url_prefix}
            onChange={(event) =>
              updateDraft('epay_url_prefix', event.target.value)
            }
            placeholder="https://pay.example.com/"
            className="h-11 w-full rounded-lg border border-hairline bg-canvas px-3 text-sm focus:border-hairline focus:outline-none"
          />
        </label>
        <label className="space-y-1.5">
          <div className="text-[12px] font-medium text-muted">
            商户 ID
          </div>
          <input
            value={draft.epay_platform_id ?? ''}
            onChange={(event) =>
              updateDraft(
                'epay_platform_id',
                event.target.value
                  ? Number.parseInt(event.target.value, 10) || null
                  : null,
              )
            }
            inputMode="numeric"
            className="h-11 w-full rounded-lg border border-hairline bg-canvas px-3 text-sm focus:border-hairline focus:outline-none"
          />
        </label>
        <label className="space-y-1.5">
          <div className="text-[12px] font-medium text-muted">
            商户查询密钥
          </div>
          <input
            type="password"
            value={draft.epay_merchant_key}
            onChange={(event) =>
              updateDraft('epay_merchant_key', event.target.value)
            }
            className="h-11 w-full rounded-lg border border-hairline bg-canvas px-3 text-sm focus:border-hairline focus:outline-none"
          />
        </label>
        <label className="space-y-1.5 lg:col-span-2">
          <div className="text-[12px] font-medium text-muted">
            异步通知地址
          </div>
          <input
            value={draft.notify_url}
            onChange={(event) => updateDraft('notify_url', event.target.value)}
            placeholder="https://your-domain.com/api/billing/recharge/notify"
            className="h-11 w-full rounded-lg border border-hairline bg-canvas px-3 text-sm focus:border-hairline focus:outline-none"
          />
        </label>
        <label className="space-y-1.5 lg:col-span-2">
          <div className="text-[12px] font-medium text-muted">
            支付完成返回地址
          </div>
          <input
            value={draft.return_url}
            onChange={(event) => updateDraft('return_url', event.target.value)}
            placeholder="https://your-domain.com/wallet"
            className="h-11 w-full rounded-lg border border-hairline bg-canvas px-3 text-sm focus:border-hairline focus:outline-none"
          />
        </label>
        <label className="space-y-1.5 lg:col-span-2">
          <div className="text-[12px] font-medium text-muted">
            商户私钥
          </div>
          <textarea
            value={draft.epay_merchant_private_key}
            onChange={(event) =>
              updateDraft('epay_merchant_private_key', event.target.value)
            }
            rows={4}
            className="w-full resize-y rounded-lg border border-hairline bg-canvas px-3 py-2 text-sm focus:border-hairline focus:outline-none"
          />
        </label>
        <label className="space-y-1.5 lg:col-span-2">
          <div className="text-[12px] font-medium text-muted">
            平台公钥
          </div>
          <textarea
            value={draft.epay_platform_public_key}
            onChange={(event) =>
              updateDraft('epay_platform_public_key', event.target.value)
            }
            rows={4}
            className="w-full resize-y rounded-lg border border-hairline bg-canvas px-3 py-2 text-sm focus:border-hairline focus:outline-none"
          />
        </label>
      </div>

      <div className="mt-4 flex flex-col gap-3 border-t border-hairline/70 pt-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-[12px] text-muted">
          最近更新：
          {new Date(config.updated_at).toLocaleString('zh-CN', {
            hour12: false,
          })}
        </div>
        <button
          type="button"
          onClick={() => void onSave(draft)}
          disabled={busy}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-on-primary disabled:opacity-40"
        >
          {busy ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Save size={14} />
          )}
          保存充值配置
        </button>
      </div>
    </div>
  );
}
