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
  membership_plans?: Array<{
    plan_key: string;
    name: string;
    enabled: boolean;
    monthly_price_coins: number;
    display_price_coins: number;
    monthly_allowance_units: number;
    standard_price_per_million_units_coins: number;
  }>;
  free_professional_ai: {
    daily_turn_limit: number;
  };
};

type MembershipPlanDraft = {
  plan_key: string;
  name: string;
  enabled: boolean;
  monthly_price_coins: string;
  display_price_coins: string;
  monthly_allowance_units: string;
  standard_price_per_million_units_coins: string;
};

type RewardDraft = {
  daily_sign_in: {
    enabled: boolean;
    reward_coins: string;
  };
  free_professional_ai: {
    daily_turn_limit: string;
  };
  membership_plans: MembershipPlanDraft[];
};

function defaultMembershipPlans(): MembershipPlanDraft[] {
  return [
    {
      plan_key: 'fateclaw_plus',
      name: 'FateClaw Plus',
      enabled: true,
      monthly_price_coins: '30',
      display_price_coins: '30',
      monthly_allowance_units: '3000000',
      standard_price_per_million_units_coins: '10',
    },
    {
      plan_key: 'fateclaw_pro',
      name: 'FateClaw Pro',
      enabled: true,
      monthly_price_coins: '100',
      display_price_coins: '120',
      monthly_allowance_units: '3000000',
      standard_price_per_million_units_coins: '10',
    },
  ];
}

function planDraftFromConfig(
  plan: AdminRewardConfig['membership_plans'][number],
): MembershipPlanDraft {
  return {
    plan_key: plan.plan_key,
    name: plan.name,
    enabled: plan.enabled,
    monthly_price_coins: String(plan.monthly_price_coins),
    display_price_coins: String(plan.display_price_coins),
    monthly_allowance_units: String(plan.monthly_allowance_units),
    standard_price_per_million_units_coins: String(
      plan.standard_price_per_million_units_coins,
    ),
  };
}

function draftFromConfig(config: AdminRewardConfig | null): RewardDraft {
  return {
    daily_sign_in: {
      enabled: config?.daily_sign_in.enabled ?? false,
      reward_coins: String(config?.daily_sign_in.reward_coins ?? 0),
    },
    free_professional_ai: {
      daily_turn_limit: String(
        config?.free_professional_ai.daily_turn_limit ?? 5,
      ),
    },
    membership_plans:
      config?.membership_plans?.map(planDraftFromConfig) ??
      defaultMembershipPlans(),
  };
}

function roundCurrency(value: string) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function payloadPlanFromDraft(plan: MembershipPlanDraft) {
  return {
    plan_key: plan.plan_key,
    name: plan.name.trim() || plan.plan_key,
    enabled: plan.enabled,
    monthly_price_coins: roundCurrency(plan.monthly_price_coins),
    display_price_coins: roundCurrency(plan.display_price_coins),
    monthly_allowance_units: Number(plan.monthly_allowance_units || 0),
    standard_price_per_million_units_coins: roundCurrency(
      plan.standard_price_per_million_units_coins,
    ),
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
  const updateFreeProfessionalAi = (
    value: Partial<RewardDraft['free_professional_ai']>,
  ) => {
    setDraft((prev) => ({
      ...prev,
      free_professional_ai: {
        ...prev.free_professional_ai,
        ...value,
      },
    }));
  };
  const updateMembershipPlan = (
    planKey: string,
    value: Partial<MembershipPlanDraft>,
  ) => {
    setDraft((prev) => ({
      ...prev,
      membership_plans: prev.membership_plans.map((plan) =>
        plan.plan_key === planKey ? { ...plan, ...value } : plan,
      ),
    }));
  };
  const plusPlan =
    draft.membership_plans.find((plan) => plan.plan_key === 'fateclaw_plus') ??
    draft.membership_plans[0] ??
    defaultMembershipPlans()[0];

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
        <div>
          <div className="text-sm font-semibold">Free 专业模式 AI</div>
          <div className="mt-1 text-[12px] leading-5 text-muted">
            控制未开通 Plus / Pro 的用户每天可发起的专业模式 AI 轮数，追问同样计入。
          </div>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <label className="space-y-1.5">
            <div className="text-[12px] font-medium text-muted">
              每日免费次数
            </div>
            <input
              value={draft.free_professional_ai.daily_turn_limit}
              onChange={(event) =>
                updateFreeProfessionalAi({
                  daily_turn_limit: event.target.value,
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
                {Math.max(
                  0,
                  Math.trunc(
                    Number(draft.free_professional_ai.daily_turn_limit) || 0,
                  ),
                )}
              </span>
              {' '}
              次 / 天
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        {draft.membership_plans.map((plan) => (
          <div
            key={plan.plan_key}
            className="rounded-lg border border-hairline bg-surface-card p-4 sm:p-5"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <input
                  value={plan.name}
                  onChange={(event) =>
                    updateMembershipPlan(plan.plan_key, {
                      name: event.target.value,
                    })
                  }
                  className="h-8 w-full rounded-md border border-transparent bg-transparent px-0 text-sm font-semibold text-ink focus:border-hairline focus:bg-canvas focus:px-2 focus:outline-none sm:w-[220px]"
                />
                <div className="mt-1 text-[12px] leading-5 text-muted">
                  管理会员月费、展示原价、后台额度池和额度进度条的成本折算口径。
                </div>
              </div>
              <label className="inline-flex items-center gap-2 text-[13px] text-muted">
                <input
                  type="checkbox"
                  checked={plan.enabled}
                  onChange={(event) =>
                    updateMembershipPlan(plan.plan_key, {
                      enabled: event.target.checked,
                    })
                  }
                  className="h-4 w-4 accent-primary"
                />
                开放套餐
              </label>
            </div>

            <div className="mt-4 grid gap-3 lg:grid-cols-4">
              <label className="space-y-1.5">
                <div className="text-[12px] font-medium text-muted">
                  实收月费（软妹币）
                </div>
                <input
                  value={plan.monthly_price_coins}
                  onChange={(event) =>
                    updateMembershipPlan(plan.plan_key, {
                      monthly_price_coins: event.target.value,
                    })
                  }
                  inputMode="decimal"
                  className="h-11 w-full rounded-lg border border-hairline bg-canvas px-3 text-sm focus:border-hairline focus:outline-none"
                />
              </label>
              <label className="space-y-1.5">
                <div className="text-[12px] font-medium text-muted">
                  展示原价（软妹币）
                </div>
                <input
                  value={plan.display_price_coins}
                  onChange={(event) =>
                    updateMembershipPlan(plan.plan_key, {
                      display_price_coins: event.target.value,
                    })
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
                  value={plan.monthly_allowance_units}
                  onChange={(event) =>
                    updateMembershipPlan(plan.plan_key, {
                      monthly_allowance_units: event.target.value,
                    })
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
                  value={plan.standard_price_per_million_units_coins}
                  onChange={(event) =>
                    updateMembershipPlan(plan.plan_key, {
                      standard_price_per_million_units_coins:
                        event.target.value,
                    })
                  }
                  inputMode="decimal"
                  className="h-11 w-full rounded-lg border border-hairline bg-canvas px-3 text-sm focus:border-hairline focus:outline-none"
                />
              </label>
            </div>
            <div className="mt-3 rounded-lg border border-hairline bg-canvas px-3 py-2 text-[12px] text-muted">
              当前展示：
              <span className="font-medium text-ink">
                {formatCoins(Number(plan.monthly_price_coins) || 0)}
              </span>
              {Number(plan.display_price_coins) >
                Number(plan.monthly_price_coins) && (
                <span>
                  {' '}
                  / 原价 {formatCoins(Number(plan.display_price_coins) || 0)}
                </span>
              )}
            </div>
          </div>
        ))}
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
                enabled: plusPlan.enabled,
                monthly_price_coins: roundCurrency(
                  plusPlan.monthly_price_coins,
                ),
                monthly_allowance_units: Number(
                  plusPlan.monthly_allowance_units || 0,
                ),
                standard_price_per_million_units_coins: roundCurrency(
                  plusPlan.standard_price_per_million_units_coins,
                ),
              },
              membership_plans:
                draft.membership_plans.map(payloadPlanFromDraft),
              free_professional_ai: {
                daily_turn_limit: Math.max(
                  0,
                  Math.trunc(
                    Number(draft.free_professional_ai.daily_turn_limit) || 0,
                  ),
                ),
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
