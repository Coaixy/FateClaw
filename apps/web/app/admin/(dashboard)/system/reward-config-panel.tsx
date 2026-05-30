'use client';

import { useEffect, useState } from 'react';
import { CalendarCheck, Loader2, Save } from 'lucide-react';

import type { AdminRewardConfig } from '@/lib/admin-api';
import { formatCoins } from '@/lib/soft-currency';

type RewardDraft = {
  daily_sign_in: {
    enabled: boolean;
    reward_coins: number;
  };
};

function draftFromConfig(config: AdminRewardConfig | null): RewardDraft {
  return {
    daily_sign_in: {
      enabled: config?.daily_sign_in.enabled ?? false,
      reward_coins: config?.daily_sign_in.reward_coins ?? 0,
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
  onSave: (draft: RewardDraft) => Promise<void>;
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
      daily_sign_in: {
        ...prev.daily_sign_in,
        ...value,
      },
    }));
  };

  return (
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
                reward_coins: Math.max(
                  0,
                  Number.parseInt(event.target.value, 10) || 0,
                ),
              })
            }
            inputMode="numeric"
            className="h-11 w-full rounded-lg border border-hairline bg-canvas px-3 text-sm focus:border-hairline focus:outline-none"
          />
        </label>
        <div className="flex items-end">
          <div className="min-h-11 w-full rounded-lg border border-hairline bg-canvas px-3 py-2 text-[12px] text-muted">
            当前设置：
            <span className="font-medium text-ink">
              {formatCoins(draft.daily_sign_in.reward_coins)}
            </span>
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-3 border-t border-hairline/70 pt-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-[12px] text-muted">
          最近更新：
          {new Date(config.daily_sign_in.updated_at).toLocaleString('zh-CN', {
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
          保存软妹币配置
        </button>
      </div>
    </div>
  );
}
