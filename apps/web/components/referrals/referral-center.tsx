'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  Copy,
  Gift,
  Link as LinkIcon,
  Loader2,
  PlusCircle,
  RefreshCw,
  Share2,
  Users,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { normalizeMembershipPlanKey } from '@/features/billing/membership-plans';
import { referralsApi, type MyReferralSummary } from '@/features/referrals/api';
import { useI18n } from '@/lib/i18n';
import { useToast } from '@/lib/use-toast';

function referralLink(summary: MyReferralSummary): string {
  if (summary.invite_url.startsWith('http')) return summary.invite_url;
  if (typeof window === 'undefined') return summary.invite_url;
  return new URL(summary.invite_url, window.location.origin).toString();
}

function referralRewardPlanName(summary: MyReferralSummary): string {
  // 会员已塌缩为单层「卦师使用权」(clarity);存量 deep/insight 保留可读标签以防旧返利配置。
  const planKey = normalizeMembershipPlanKey(
    summary.config.reward_membership_plan_key,
    'fateclaw_clarity',
  );
  if (planKey === 'fateclaw_deep') return 'FateClaw Deep';
  if (planKey === 'fateclaw_insight') return 'FateClaw Insight';
  return '卦师使用权';
}

async function writeClipboardText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const textArea = document.createElement('textarea');
    textArea.value = value;
    textArea.setAttribute('readonly', 'true');
    textArea.style.position = 'fixed';
    textArea.style.left = '-9999px';
    textArea.style.top = '0';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      return document.execCommand('copy');
    } finally {
      document.body.removeChild(textArea);
    }
  }
}

function InviteMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="border-t border-hairline px-4 py-3 sm:border-l sm:border-t-0">
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted">
        {label}
      </div>
      <div className="mt-1 text-2xl font-extrabold tabular-nums">{value}</div>
    </div>
  );
}

function RuleRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted">
        {label}
      </div>
      <div className="text-[12px] font-semibold leading-5 text-ink sm:text-right">
        {value}
      </div>
    </div>
  );
}

function ReferralCenterSkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-[150px] animate-pulse rounded-2xl border border-hairline bg-surface-card" />
      <div className="h-[220px] animate-pulse rounded-2xl border border-hairline bg-surface-card" />
    </div>
  );
}

/**
 * 渲染用户侧邀请中心。
 *
 * @returns 当前用户的邀请码、邀请链接、返会员统计和复制操作入口。
 */
export function ReferralCenter() {
  const { toast } = useToast();
  const { formatDate, t } = useI18n();
  const [summary, setSummary] = useState<MyReferralSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [redeeming, setRedeeming] = useState(false);
  const [rulesExpanded, setRulesExpanded] = useState(false);
  const [redeemCode, setRedeemCode] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setSummary(await referralsApi.me());
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t('pages.referrals.loadFailed'),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const copyText = async (value: string, successMessage: string) => {
    if (!value || busy) return;
    setBusy(true);
    try {
      if (await writeClipboardText(value)) {
        toast('success', successMessage);
      } else {
        toast('error', t('pages.referrals.copyFailed'));
      }
    } catch {
      toast('error', t('pages.referrals.copyFailed'));
    } finally {
      setBusy(false);
    }
  };

  const redeemInviteCode = async (event: React.FormEvent) => {
    event.preventDefault();
    const code = redeemCode.trim().toUpperCase();
    if (!code || redeeming) return;
    setRedeeming(true);
    try {
      await referralsApi.redeem(code);
      setRedeemCode('');
      toast('success', t('pages.referrals.inviteCodeBound'));
      await load();
    } catch (err) {
      toast(
        'error',
        err instanceof Error
          ? err.message
          : t('pages.referrals.bindInviteFailed'),
      );
    } finally {
      setRedeeming(false);
    }
  };

  const link = summary ? referralLink(summary) : '';
  const rewardPlanName = summary ? referralRewardPlanName(summary) : '';
  const countRewardEnabled = summary
    ? summary.config.invite_count_reward_threshold > 0 &&
      summary.config.invite_count_reward_days > 0 &&
      summary.config.invite_count_reward_max_invites > 0
    : false;

  return (
    <AppShell>
      <div className="mb-4 space-y-1.5">
        <div className="inline-flex items-center rounded-full border border-hairline bg-surface-card px-2.5 py-1 text-[10px] font-medium text-muted">
          {t('pages.referrals.badge')}
        </div>
        <h2 className="text-[15px] font-semibold tracking-tight">
          {t('pages.referrals.title')}
        </h2>
        <p className="max-w-[520px] text-[11px] leading-5 text-muted">
          {t('pages.referrals.description')}
        </p>
      </div>

      {loading ? (
        <ReferralCenterSkeleton />
      ) : error || !summary ? (
        <section className="rounded-2xl border border-error/25 bg-surface-card p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2 text-[13px] font-semibold">
                <Gift size={15} className="text-error" />
                {t('pages.referrals.loadFailed')}
              </div>
              <div className="mt-1 text-[12px] leading-5 text-error">
                {error || t('common.retryLater')}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-hairline px-3 text-[12px] font-medium text-muted"
            >
              <RefreshCw size={13} />
              {t('pages.common.retry')}
            </button>
          </div>
        </section>
      ) : (
        <div className="space-y-4">
          <section className="overflow-hidden rounded-2xl border border-hairline bg-surface-card">
            <div className="p-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-[13px] font-semibold">
                    <Gift size={15} className="text-primary" />
                    {t('pages.referrals.myCode')}
                  </div>
                  <div className="mt-3 break-all font-mono text-4xl font-extrabold tracking-wide text-primary">
                    {summary.invite_code}
                  </div>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <button
                    type="button"
                    onClick={() =>
                      void copyText(
                        summary.invite_code,
                        t('pages.referrals.copyCodeSuccess'),
                      )
                    }
                    disabled={busy}
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-hairline bg-canvas px-3 text-[12px] font-medium text-muted hover:text-ink disabled:opacity-40"
                  >
                    <Copy size={13} />
                    {t('pages.referrals.copyCode')}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void copyText(link, t('pages.referrals.copyLinkSuccess'))
                    }
                    disabled={busy}
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-3 text-[12px] font-medium text-on-primary disabled:opacity-40"
                  >
                    <Share2 size={13} />
                    {t('pages.referrals.copyLink')}
                  </button>
                </div>
              </div>
              <div className="mt-4 flex items-start gap-2 rounded-xl bg-canvas/60 px-3 py-2.5 text-[11px] leading-5 text-muted">
                <LinkIcon size={13} className="mt-0.5 shrink-0 text-primary" />
                <span className="break-all">{link}</span>
              </div>
              {summary.bound_referral ? (
                <div className="mt-3 flex flex-col gap-2 rounded-xl border border-hairline bg-canvas/55 px-3 py-2.5 text-[12px] leading-5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-start gap-2 text-muted">
                    <CheckCircle2
                      size={14}
                      className="mt-0.5 shrink-0 text-primary"
                    />
                    <span>{t('pages.referrals.boundHint')}</span>
                  </div>
                  <div className="shrink-0 pl-6 text-[11px] font-medium text-muted sm:pl-0">
                    {formatDate(summary.bound_referral.created_at, {
                      year: 'numeric',
                      month: '2-digit',
                      day: '2-digit',
                    })}
                  </div>
                </div>
              ) : null}
            </div>

            <div className="grid bg-canvas/35 sm:grid-cols-3">
              <InviteMetric
                label={t('pages.referrals.invited')}
                value={summary.invited_count}
              />
              <InviteMetric
                label={t('pages.referrals.rewarded')}
                value={summary.rewarded_count}
              />
              <InviteMetric
                label={t('pages.referrals.totalRewardDays')}
                value={summary.total_reward_days}
              />
            </div>
          </section>

          {!summary.bound_referral ? (
            <section className="rounded-2xl border border-hairline bg-surface-card p-5">
              <div>
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="flex items-center gap-2 text-[13px] font-semibold">
                      <PlusCircle size={15} className="text-primary" />
                      {t('pages.referrals.bindCode')}
                    </div>
                    <div className="mt-1 text-[12px] leading-5 text-muted">
                      {t('pages.referrals.bindCodeDescription')}
                    </div>
                  </div>
                </div>
                <form
                  onSubmit={redeemInviteCode}
                  className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto]"
                >
                  <input
                    value={redeemCode}
                    onChange={(event) =>
                      setRedeemCode(event.target.value.toUpperCase())
                    }
                    maxLength={64}
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder={t('pages.referrals.bindCodePlaceholder')}
                    className="h-11 rounded-xl border border-hairline bg-canvas px-3 text-sm font-medium outline-none transition-colors focus:border-primary"
                  />
                  <button
                    type="submit"
                    disabled={redeeming || !redeemCode.trim()}
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-[13px] font-medium text-on-primary disabled:opacity-40"
                  >
                    {redeeming ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : null}
                    {t('pages.referrals.bind')}
                  </button>
                </form>
              </div>
            </section>
          ) : null}

          <section className="rounded-2xl border border-hairline bg-surface-card p-5">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Users size={16} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold">
                      {t('pages.referrals.rewardRules')}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <span className="rounded-full border border-hairline bg-canvas/55 px-2.5 py-1 text-[11px] font-medium text-muted">
                        {summary.config.enabled
                          ? t('pages.common.enabled')
                          : t('pages.common.disabled')}
                      </span>
                      <span className="rounded-full border border-hairline bg-canvas/55 px-2.5 py-1 text-[11px] font-medium text-muted">
                        {t('pages.referrals.rewardDays', {
                          days: summary.config.inviter_reward_days,
                          plan: rewardPlanName,
                        })}
                      </span>
                      {countRewardEnabled ? (
                        <span className="rounded-full border border-hairline bg-canvas/55 px-2.5 py-1 text-[11px] font-medium text-muted">
                          {t('pages.referrals.countRewardSummary', {
                            count: summary.config.invite_count_reward_threshold,
                            days: summary.config.invite_count_reward_days,
                            plan: rewardPlanName,
                          })}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-expanded={rulesExpanded}
                    aria-controls="referral-rules-panel"
                    onClick={() => setRulesExpanded((expanded) => !expanded)}
                    className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg border border-hairline bg-canvas px-3 text-[12px] font-medium text-muted transition-colors hover:text-ink"
                  >
                    {rulesExpanded
                      ? t('pages.referrals.collapse')
                      : t('pages.referrals.expand')}
                    <ChevronDown
                      size={14}
                      className={
                        rulesExpanded
                          ? 'rotate-180 transition-transform'
                          : 'transition-transform'
                      }
                    />
                  </button>
                </div>
                {rulesExpanded ? (
                  <div
                    id="referral-rules-panel"
                    className="mt-3 divide-y divide-hairline rounded-xl border border-hairline bg-canvas/45 px-3"
                  >
                    <RuleRow
                      label={t('pages.referrals.ruleEnabled')}
                      value={
                        summary.config.enabled
                          ? t('pages.common.enabled')
                          : t('pages.common.disabled')
                      }
                    />
                    <RuleRow
                      label={t('pages.referrals.ruleInviterReward')}
                      value={t('pages.referrals.rewardPlanDays', {
                        days: summary.config.inviter_reward_days,
                        plan: rewardPlanName,
                      })}
                    />
                    <RuleRow
                      label={t('pages.referrals.ruleMonthlyCap')}
                      value={t('pages.common.daysMember', {
                        days: summary.config.monthly_reward_cap_days,
                      })}
                    />
                    <RuleRow
                      label={t('pages.referrals.ruleTrigger')}
                      value={
                        summary.config.reward_first_membership_only
                          ? t('pages.referrals.ruleTriggerFirst')
                          : t('pages.referrals.ruleTriggerAny')
                      }
                    />
                    <RuleRow
                      label={t('pages.referrals.rulePayment')}
                      value={t('pages.referrals.rulePaymentValue')}
                    />
                    <RuleRow
                      label={t('pages.referrals.ruleInviteCountReward')}
                      value={
                        countRewardEnabled
                          ? t('pages.referrals.ruleInviteCountRewardValue', {
                              count:
                                summary.config.invite_count_reward_threshold,
                              days: summary.config.invite_count_reward_days,
                              plan: rewardPlanName,
                              max: summary.config
                                .invite_count_reward_max_invites,
                            })
                          : t('pages.common.disabled')
                      }
                    />
                    <RuleRow
                      label={t('pages.referrals.ruleBinding')}
                      value={t('pages.referrals.ruleBindingValue')}
                    />
                  </div>
                ) : null}
              </div>
            </div>
          </section>
        </div>
      )}
    </AppShell>
  );
}
