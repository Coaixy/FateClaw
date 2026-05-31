'use client';

import { useEffect, useState } from 'react';
import { CalendarCheck, Loader2, Save } from 'lucide-react';

import type { AdminRewardConfig } from '@/lib/admin-api';
import { formatCoins } from '@/lib/soft-currency';

type RewardConfigPayload = {
  daily_sign_in: {
    enabled: boolean;
    reward_coins: number;
  };
  membership: {
    enabled: boolean;
    monthly_price_coins: number;
    monthly_allowance_units: number;
    standard_price_per_million_units_coins: number;
  };
};

type RewardDraft = {
  daily_sign_in: {
    enabled: boolean;
    reward_coins: string;
  };
  membership: {
    enabled: boolean;
    monthly_price_coins: string;
    monthly_allowance_units: string;
    standard_price_per_million_units_coins: string;
  };
};

function draftFromConfig(config: AdminRewardConfig | null): RewardDraft {
  return {
    daily_sign_in: {
      enabled: config?.daily_sign_in.enabled ?? false,
      reward_coins: String(config?.daily_sign_in.reward_coins ?? 0),
    },
    membership: {
      enabled: config?.membership.enabled ?? true,
      monthly_price_coins: String(config?.membership.monthly_price_coins ?? 30),
      monthly_allowance_units: String(
        config?.membership.monthly_allowance_units ?? 3000000,
      ),
      standard_price_per_million_units_coins: String(
        config?.membership.standard_price_per_million_units_coins ?? 10,
      ),
    },
  };
}

/**
 * 管理后台软妹币配置面板。
 */
export function RewardConfigPanel({
  config,
  busy,
  onSave,
}: {
  config: AdminRewardConfig | null;
  busy: boolean;
  onSave: (draft: RewardConfigPayload) => Promise<void>;
}) {
  const [draft, setDraft] = useState<RewardDraft>(() =>
    draftFromConfig(config),
  );

  useEffect(() => {
    setDraft(draftFromConfig(config));
  }, [config]);

  if (!config) {
    return (
      <div className="rounded-lg border border-hairline bg-surface-card p-4 text-[13px] text-muted">
        软妹币配置加载中...
      </div>
    );
  }

  const updateDailySignIn = (
    value: Partial<RewardDraft['daily_sign_in']>,
  ) => {
    setDraft((prev) => ({
      ...prev,
      daily_sign_in: {
        ...prev.daily_sign_in,
        ...value,
      },
    }));
  };
  const updateMembership = (value: Partial<RewardDraft['membership']>) => {
    setDraft((prev) => ({
      ...prev,
      membership: {
        ...prev.membership,
        ...value,
      },
    }));
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-hairline bg-surface-card p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold">
              <CalendarCheck size={15} className="text-muted" />
              每日签到
            </div>
            <div className="mt-1 text-[12px] leading-5 text-muted">
              开启后用户每天可在钱包页领取一次软妹币奖励。
            </div>
          </div>
          <label className="inline-flex items-center gap-2 text-[13px] text-muted">
            <input
              type="checkbox"
              checked={draft.daily_sign_in.enabled}
              onChange={(event) =>
                updateDailySignIn({ enabled: event.target.checked })
              }
              className="h-4 w-4 accent-primary"
            />
            开启签到
          </label>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <label className="space-y-1.5">
            <div className="text-[12px] font-medium text-muted">
              每日奖励（软妹币）
            </div>
            <input
              value={draft.daily_sign_in.reward_coins}
              onChange={(event) =>
                updateDailySignIn({
                  reward_coins: event.target.value,
                })
              }
              inputMode="decimal"
              className="h-11 w-full rounded-lg border border-hairline bg-canvas px-3 text-sm focus:border-hairline focus:outline-none"
            />
          </label>
          <div className="flex items-end">
            <div className="min-h-11 w-full rounded-lg border border-hairline bg-canvas px-3 py-2 text-[12px] text-muted">
              当前设置：
              <span className="font-medium text-ink">
                {formatCoins(Number(draft.daily_sign_in.reward_coins) || 0)}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-hairline bg-surface-card p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="text-sm font-semibold">FateClaw Plus</div>
            <div className="mt-1 text-[12px] leading-5 text-muted">
              管理会员月费、后台额度池和额度进度条的成本折算口径。
            </div>
          </div>
          <label className="inline-flex items-center gap-2 text-[13px] text-muted">
            <input
              type="checkbox"
              checked={draft.membership.enabled}
              onChange={(event) =>
                updateMembership({ enabled: event.target.checked })
              }
              className="h-4 w-4 accent-primary"
            />
            开放会员
          </label>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-3">
          <label className="space-y-1.5">
            <div className="text-[12px] font-medium text-muted">
              月费（软妹币）
            </div>
            <input
              value={draft.membership.monthly_price_coins}
              onChange={(event) =>
                updateMembership({ monthly_price_coins: event.target.value })
              }
              inputMode="decimal"
              className="h-11 w-full rounded-lg border border-hairline bg-canvas px-3 text-sm focus:border-hairline focus:outline-none"
            />
          </label>
          <label className="space-y-1.5">
            <div className="text-[12px] font-medium text-muted">
              月度标准额度
            </div>
            <input
              value={draft.membership.monthly_allowance_units}
              onChange={(event) =>
                updateMembership({ monthly_allowance_units: event.target.value })
              }
              inputMode="numeric"
              className="h-11 w-full rounded-lg border border-hairline bg-canvas px-3 text-sm focus:border-hairline focus:outline-none"
            />
          </label>
          <label className="space-y-1.5">
            <div className="text-[12px] font-medium text-muted">
              百万标准额度成本
            </div>
            <input
              value={draft.membership.standard_price_per_million_units_coins}
              onChange={(event) =>
                updateMembership({
                  standard_price_per_million_units_coins: event.target.value,
                })
              }
              inputMode="decimal"
              className="h-11 w-full rounded-lg border border-hairline bg-canvas px-3 text-sm focus:border-hairline focus:outline-none"
            />
          </label>
        </div>
        <div className="mt-3 rounded-lg border border-hairline bg-canvas px-3 py-2 text-[12px] text-muted">
          用户侧只显示进度条；这里的额度和折算价格用于后台运营调整。
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-hairline bg-surface-card p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
        <div className="text-[12px] text-muted">
          会员配置最近更新：
          {new Date(config.membership.updated_at).toLocaleString('zh-CN', {
            hour12: false,
          })}
        </div>
        <button
          type="button"
          onClick={() =>
            void onSave({
              daily_sign_in: {
                ...draft.daily_sign_in,
                reward_coins:
                  Math.round(Number(draft.daily_sign_in.reward_coins || 0) * 100) /
                  100,
              },
              membership: {
                enabled: draft.membership.enabled,
                monthly_price_coins:
                  Math.round(
                    Number(draft.membership.monthly_price_coins || 0) * 100,
                  ) / 100,
                monthly_allowance_units: Number(
                  draft.membership.monthly_allowance_units || 0,
                ),
                standard_price_per_million_units_coins:
                  Math.round(
                    Number(
                      draft.membership.standard_price_per_million_units_coins ||
                        0,
                    ) * 100,
                  ) / 100,
              },
            })
          }
          disabled={busy}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-on-primary disabled:opacity-40"
        >
          {busy ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Save size={14} />
          )}
          保存配置
        </button>
      </div>
    </div>
  );
}
