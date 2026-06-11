'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Copy,
  Gift,
  Link as LinkIcon,
  Loader2,
  RefreshCw,
  Share2,
  Users,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { referralsApi, type MyReferralSummary } from '@/features/referrals/api';
import { useToast } from '@/lib/use-toast';

function referralLink(summary: MyReferralSummary): string {
  if (summary.invite_url.startsWith('http')) return summary.invite_url;
  if (typeof window === 'undefined') return summary.invite_url;
  return new URL(summary.invite_url, window.location.origin).toString();
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
    <div className="flex min-h-10 items-center justify-between gap-3 border-t border-hairline py-2 first:border-t-0">
      <span className="text-[12px] text-muted">{label}</span>
      <span className="text-right text-[12px] font-semibold text-ink">
        {value}
      </span>
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
  const [summary, setSummary] = useState<MyReferralSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setSummary(await referralsApi.me());
    } catch (err) {
      setError(err instanceof Error ? err.message : '邀请信息加载失败');
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
        toast('error', '复制失败');
      }
    } catch {
      toast('error', '复制失败');
    } finally {
      setBusy(false);
    }
  };

  const link = summary ? referralLink(summary) : '';

  return (
    <AppShell>
      <div className="mb-4 space-y-1.5">
        <div className="inline-flex items-center rounded-full border border-hairline bg-surface-card px-2.5 py-1 text-[10px] font-medium text-muted">
          Referral Center
        </div>
        <h2 className="text-[15px] font-semibold tracking-tight">邀请中心</h2>
        <p className="max-w-[520px] text-[11px] leading-5 text-muted">
          分享邀请码给好友。好友首次使用充值余额开通会员后，你会获得会员天数奖励。
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
                邀请信息加载失败
              </div>
              <div className="mt-1 text-[12px] leading-5 text-error">
                {error || '请稍后重试'}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-hairline px-3 text-[12px] font-medium text-muted"
            >
              <RefreshCw size={13} />
              重试
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
                    我的邀请码
                  </div>
                  <div className="mt-3 break-all font-mono text-4xl font-extrabold tracking-wide text-primary">
                    {summary.invite_code}
                  </div>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <button
                    type="button"
                    onClick={() =>
                      void copyText(summary.invite_code, '邀请码已复制到剪贴板')
                    }
                    disabled={busy}
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-hairline bg-canvas px-3 text-[12px] font-medium text-muted hover:text-ink disabled:opacity-40"
                  >
                    <Copy size={13} />
                    复制邀请码
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void copyText(link, '邀请链接已复制到剪贴板')
                    }
                    disabled={busy}
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-3 text-[12px] font-medium text-on-primary disabled:opacity-40"
                  >
                    <Share2 size={13} />
                    复制邀请链接
                  </button>
                </div>
              </div>
              <div className="mt-4 flex items-start gap-2 rounded-xl bg-canvas/60 px-3 py-2.5 text-[11px] leading-5 text-muted">
                <LinkIcon size={13} className="mt-0.5 shrink-0 text-primary" />
                <span className="break-all">{link}</span>
              </div>
            </div>

            <div className="grid bg-canvas/35 sm:grid-cols-3">
              <InviteMetric label="已邀请" value={summary.invited_count} />
              <InviteMetric label="已奖励" value={summary.rewarded_count} />
              <InviteMetric
                label="累计会员天数"
                value={summary.total_reward_days}
              />
            </div>
          </section>

          <section className="rounded-2xl border border-hairline bg-surface-card p-5">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Users size={16} />
              </div>
              <div>
                <div className="text-[13px] font-semibold">奖励规则</div>
                <div className="mt-3 rounded-xl border border-hairline bg-canvas/45 px-3">
                  <RuleRow
                    label="邀请功能"
                    value={summary.config.enabled ? '已开启' : '已关闭'}
                  />
                  <RuleRow
                    label="邀请者奖励"
                    value={`${summary.config.inviter_reward_days} 天会员`}
                  />
                  <RuleRow
                    label="每月奖励上限"
                    value={`${summary.config.monthly_reward_cap_days} 天会员`}
                  />
                  <RuleRow
                    label="奖励触发"
                    value={
                      summary.config.reward_first_membership_only
                        ? '仅首次会员购买'
                        : '符合条件的会员购买'
                    }
                  />
                  <RuleRow label="支付条件" value="仅纯充值余额支付会员" />
                  <RuleRow
                    label="绑定规则"
                    value="绑定后不可更换，不允许自邀或循环绑定"
                  />
                </div>
              </div>
            </div>
          </section>
        </div>
      )}
    </AppShell>
  );
}
