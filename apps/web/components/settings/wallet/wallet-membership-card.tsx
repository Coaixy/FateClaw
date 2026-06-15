import { Crown, Loader2 } from 'lucide-react';

import type { BillingStatus } from '@/features/billing/api';
import { resolveMembershipPlanDisplayName } from '@/features/billing/membership-plans';
import { formatCoins } from '@/lib/soft-currency';

type MembershipStatus = BillingStatus['membership'];

function membershipStatusText(status: MembershipStatus['allowance_status']) {
  switch (status) {
    case 'plenty':
      return '额度充足';
    case 'normal':
      return '正常使用中';
    case 'tight':
      return '额度偏紧';
    case 'almost_used':
      return '即将用完';
    case 'used_up':
      return '本月会员免费额度已用完';
    case 'inactive':
    default:
      return '未开通';
  }
}

function resetText(value: string | null) {
  if (!value) return '开通后按月重置';
  return `将在 ${new Date(value).toLocaleDateString('zh-CN')} 重置`;
}

function progressPercent(ratio: number) {
  const percent = Math.min(100, Math.max(0, ratio * 100));
  if (percent > 0 && percent < 0.1) {
    return 0.1;
  }
  return Math.round(percent * 10) / 10;
}

function displayPercent(ratio: number) {
  const percent = Math.min(100, Math.max(0, ratio * 100));
  if (percent === 0) return '0%';
  if (percent < 0.01) return '< 0.01%';
  if (percent < 0.1) return `${percent.toFixed(2)}%`;
  if (percent < 10) return `${percent.toFixed(1)}%`;
  return `${Math.round(percent)}%`;
}

/**
 * 渲染 FateClaw 会员订阅卡片。
 *
 * @param props.membership 当前会员状态和额度进度。
 * @param props.busy 是否正在提交开通或续费请求。
 * @param props.onSubscribe 用户点击开通或续费会员时的回调。
 * @returns 当前会员订阅信息、权益标签、额度进度和订阅按钮。
 */
export function WalletMembershipCard({
  membership,
  busy,
  onSubscribe,
}: {
  membership: MembershipStatus;
  busy: boolean;
  onSubscribe: () => void;
}) {
  const usedPercent = progressPercent(membership.allowance_used_ratio);
  const usedPercentText = displayPercent(membership.allowance_used_ratio);
  const active = membership.active;
  const planDisplayName = resolveMembershipPlanDisplayName({
    plan_key: membership.plan_key ?? 'fateclaw_clarity',
  });

  return (
    <section className="rounded-2xl border border-hairline bg-surface-card p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-[13px] font-semibold">
            <Crown size={15} className="text-primary" />
            {planDisplayName}
          </div>
          <div className="mt-1 text-[12px] leading-5 text-muted">
            {formatCoins(membership.monthly_price_coins)} / 月 ·
            会员免费额度优先抵扣 AI Chat 消耗
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {['专家模式', '每日专家次数', '会员额度优先抵扣'].map((item) => (
              <span
                key={item}
                className="rounded-full border border-hairline bg-surface-cream-strong px-2 py-1 text-[10px] font-medium text-muted"
              >
                {item}
              </span>
            ))}
          </div>
        </div>
        <button
          type="button"
          onClick={onSubscribe}
          disabled={busy || !membership.enabled}
          className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-primary px-3 text-[12px] font-medium text-on-primary disabled:opacity-40"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : null}
          {active ? '续费会员' : '开通会员'}
        </button>
      </div>

      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between gap-3 text-[12px]">
          <span className="font-medium">
            {membershipStatusText(membership.allowance_status)}
          </span>
          <span className="text-muted">
            {active ? `已使用 ${usedPercentText}` : '会员免费额度进度'}
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-hairline">
          <div
            className="h-full rounded-full bg-primary transition-[width]"
            style={{ width: `${active ? usedPercent : 0}%` }}
          />
        </div>
        <div className="mt-2 text-[11px] leading-5 text-muted">
          {active
            ? `${resetText(membership.allowance_reset_at)}；额度用完后将继续使用积分余额。`
            : membership.enabled
              ? '开通后会员免费额度优先抵扣 AI Chat 消耗；额度用完后继续使用积分余额。'
              : '会员暂未开放购买，当前仍按积分余额扣费。'}
        </div>
      </div>
    </section>
  );
}
