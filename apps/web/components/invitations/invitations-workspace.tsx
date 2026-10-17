'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Check,
  Copy,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Ticket,
  X,
} from 'lucide-react';
import type {
  CreatedRegistrationInviteDto,
  RegistrationInviteSummaryDto,
} from '@fateclaw/contracts/auth';

import { registrationInvitesApi } from '@/features/invitations/api';
import { buildRegistrationInviteLink } from '@/features/invitations/links';
import { useI18n } from '@/lib/i18n';
import { useToast } from '@/lib/use-toast';

export function InvitationsWorkspace() {
  const { t } = useI18n();
  const { toast } = useToast();
  const [summary, setSummary] = useState<RegistrationInviteSummaryDto | null>(
    null,
  );
  const [created, setCreated] = useState<CreatedRegistrationInviteDto | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const requestKey = useRef<string | null>(null);
  const actionInFlight = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      setSummary(await registrationInvitesApi.summary());
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : t('invitations.loadFailed'),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const generate = async () => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setPending('create');
    setActionError('');
    try {
      // Keep the same key after an uncertain response so retrying cannot reserve another slot.
      requestKey.current ??= crypto.randomUUID();
      const result = await registrationInvitesApi.create(requestKey.current);
      requestKey.current = null;
      setCreated(result);
      await refresh();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : t('invitations.createFailed'),
      );
    } finally {
      actionInFlight.current = false;
      setPending(null);
    }
  };

  const revoke = async (id: string) => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setPending(id);
    setActionError('');
    try {
      setSummary(await registrationInvitesApi.revoke(id));
      setLoadError('');
      setCreated((value) => (value?.invite.id === id ? null : value));
      toast('success', t('invitations.revoked'));
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : t('invitations.revokeFailed'),
      );
    } finally {
      actionInFlight.current = false;
      setPending(null);
    }
  };

  const copy = async (value: string, link: boolean) => {
    try {
      await navigator.clipboard.writeText(
        link
          ? buildRegistrationInviteLink(window.location.origin, value)
          : value,
      );
      toast(
        'success',
        t(link ? 'invitations.linkCopied' : 'invitations.codeCopied'),
      );
    } catch {
      toast('error', t('invitations.copyFailed'));
    }
  };

  return (
    <InvitationsContent
      summary={summary}
      created={created}
      loading={loading}
      loadError={loadError}
      actionError={actionError}
      pending={pending}
      retrying={requestKey.current !== null}
      onRefresh={refresh}
      onGenerate={generate}
      onRevoke={revoke}
      onCopy={copy}
      onDismiss={() => setCreated(null)}
    />
  );
}

export function InvitationsContent({
  summary,
  created,
  loading,
  loadError,
  actionError,
  pending,
  retrying,
  onRefresh,
  onGenerate,
  onRevoke,
  onCopy,
  onDismiss,
}: {
  summary: RegistrationInviteSummaryDto | null;
  created: CreatedRegistrationInviteDto | null;
  loading: boolean;
  loadError: string;
  actionError: string;
  pending: string | null;
  retrying: boolean;
  onRefresh: () => void;
  onGenerate: () => void;
  onRevoke: (id: string) => void;
  onCopy: (value: string, link: boolean) => void;
  onDismiss: () => void;
}) {
  const { t, formatDate, formatNumber } = useI18n();
  const date = (value: string) =>
    formatDate(value, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  const money = (value: number) =>
    formatNumber(value, {
      style: 'currency',
      currency: 'CNY',
      maximumFractionDigits: 2,
    });
  const nextTier = summary?.policy.tiers.find(
    (tier) => tier.threshold_yuan > summary.net_recharge_yuan,
  );
  const progress =
    nextTier && summary
      ? Math.min(
          100,
          Math.max(0, (summary.net_recharge_yuan / nextTier.threshold_yuan) * 100),
        )
      : 100;
  const canGenerate =
    !loadError &&
    (retrying || (summary?.eligible && summary.available_slots > 0));

  return (
    <div className="space-y-5 pt-5 lg:pt-0">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-primary">
            <Ticket size={14} aria-hidden="true" />
            {t('invitations.badge')}
          </div>
          <h1 className="font-display text-[26px] tracking-tight text-ink">
            {t('invitations.title')}
          </h1>
          <p className="mt-2 text-[13px] leading-6 text-muted">
            {t('invitations.description')}
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading || Boolean(pending)}
          aria-label={t('invitations.refresh')}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-hairline bg-surface-raised text-muted transition-colors hover:text-ink disabled:opacity-40"
        >
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
      </header>

      {loadError ? (
        <p
          role="alert"
          className="rounded-xl border border-error/20 bg-error/5 p-4 text-[13px] text-error"
        >
          {loadError}
        </p>
      ) : null}
      {!summary && loading ? (
        <p
          role="status"
          className="flex items-center gap-2 py-10 text-sm text-muted"
        >
          <Loader2 size={16} className="animate-spin" />
          {t('common.loading')}
        </p>
      ) : null}

      {summary ? (
        <>
          <section
            aria-labelledby="invitation-eligibility"
            className="rounded-2xl border border-hairline bg-surface-raised p-5 sm:p-6"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2
                id="invitation-eligibility"
                className="flex items-center gap-2 text-sm font-semibold"
              >
                {summary.eligible ? (
                  <Check
                    size={16}
                    className="text-primary"
                    aria-hidden="true"
                  />
                ) : null}
                {t(`invitations.eligibility.${summary.eligibility_reason}`)}
              </h2>
              <span className="text-[12px] tabular-nums text-muted">
                {t('invitations.netRecharge', {
                  amount: money(summary.net_recharge_yuan),
                })}
              </span>
            </div>
            <p className="mt-3 text-[12px] leading-6 text-muted">
              {t('invitations.policy', {
                days: summary.policy.expires_in_days,
              })}
            </p>
            <ul
              aria-label={t('invitations.tiers')}
              className="mt-4 grid gap-2 sm:grid-cols-3"
            >
              {summary.policy.tiers.map((tier) => {
                const reached = summary.net_recharge_yuan >= tier.threshold_yuan;
                return (
                  <li
                    key={tier.threshold_yuan}
                    className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-3 sm:flex-col sm:items-start sm:gap-1.5 ${reached ? 'border-primary/30 bg-primary/5' : 'border-hairline bg-canvas'}`}
                  >
                    <span className="flex items-center gap-1.5 text-[11px] text-muted">
                      {t('invitations.tierThreshold', {
                        amount: money(tier.threshold_yuan),
                      })}
                      {reached ? (
                        <>
                          <Check
                            size={12}
                            className="shrink-0 text-primary"
                            aria-hidden="true"
                          />
                          <span className="sr-only">
                            {t('invitations.tierReached')}
                          </span>
                        </>
                      ) : null}
                    </span>
                    <span className="shrink-0 text-[13px] font-medium tabular-nums text-ink">
                      {t('invitations.tierSlots', { count: tier.total_slots })}
                    </span>
                  </li>
                );
              })}
            </ul>
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] leading-6">
              <p className="font-medium text-ink">
                {t('invitations.automaticAllowance', {
                  count: summary.automatic_slots,
                })}
              </p>
              {summary.manual_slot_adjustment !== 0 ? (
                <p className="text-muted">
                  {t('invitations.manualAdjustment', {
                    count: formatNumber(summary.manual_slot_adjustment, {
                      signDisplay: 'always',
                    }),
                  })}
                </p>
              ) : null}
            </div>
            <progress
              aria-label={t('invitations.rechargeProgress')}
              value={progress}
              max={100}
              className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-surface-card accent-primary [&::-webkit-progress-bar]:bg-surface-card [&::-webkit-progress-value]:bg-primary [&::-moz-progress-bar]:bg-primary"
            />
            {nextTier ? (
              <p className="mt-2 text-[12px] text-muted">
                {t('invitations.nextTierRemaining', {
                  amount: money(
                    nextTier.threshold_yuan - summary.net_recharge_yuan,
                  ),
                  slots: nextTier.total_slots,
                })}
              </p>
            ) : (
              <p className="mt-2 text-[12px] text-muted">
                {t('invitations.highestTierReached')}
              </p>
            )}
            <p className="mt-3 text-[11px] leading-5 text-muted">
              {t('invitations.rechargeBasis')}
            </p>
            {nextTier && !summary.suspended ? (
              <Link
                href="/membership"
                className="mt-4 inline-flex min-h-10 items-center rounded-lg border border-hairline bg-canvas px-3 text-[12px] font-medium text-ink"
              >
                {t('invitations.goRecharge')}
              </Link>
            ) : null}
          </section>

          <section
            aria-label={t('invitations.slots')}
            className="grid grid-cols-3 gap-3"
          >
            {(['available', 'reserved', 'used'] as const).map((kind) => (
              <div
                key={kind}
                className="rounded-xl border border-hairline bg-surface-card px-3 py-4 sm:px-5"
              >
                <p className="text-[11px] text-muted">
                  {t(`invitations.${kind}Slots`)}
                </p>
                <p className="mt-1.5 text-[25px] font-medium tabular-nums text-ink">
                  {formatNumber(summary[`${kind}_slots`])}
                </p>
              </div>
            ))}
          </section>

          {created ? (
            <section
              aria-labelledby="created-invitation"
              className="rounded-2xl border border-primary/30 bg-primary/5 p-5 sm:p-6"
            >
              <h2 id="created-invitation" className="text-sm font-semibold">
                {t(
                  created.code
                    ? 'invitations.createdTitle'
                    : 'invitations.replayedTitle',
                )}
              </h2>
              <p className="mt-2 text-[12px] leading-6 text-muted">
                {t(
                  created.code
                    ? 'invitations.oneTimeNotice'
                    : 'invitations.replayedNotice',
                )}
              </p>
              {created.code ? (
                <>
                  <input
                    readOnly
                    value={created.code}
                    aria-label={t('invitations.fullCode')}
                    onFocus={(event) => event.currentTarget.select()}
                    className="mt-4 h-11 w-full rounded-lg border border-hairline bg-canvas px-3 font-mono text-[13px] text-ink"
                  />
                  <p className="mt-2 text-[11px] text-muted">
                    {t('invitations.expiresAt', {
                      date: date(created.invite.expires_at),
                    })}
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => onCopy(created.code!, true)}
                      className="btn-tactile-primary inline-flex min-h-10 items-center gap-2 rounded-lg px-3 text-[12px] font-medium text-on-primary"
                    >
                      <Link2 size={14} />
                      {t('invitations.copyLink')}
                    </button>
                    <button
                      type="button"
                      onClick={() => onCopy(created.code!, false)}
                      className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-hairline bg-canvas px-3 text-[12px] font-medium"
                    >
                      <Copy size={14} />
                      {t('invitations.copyCode')}
                    </button>
                    <button
                      type="button"
                      onClick={onDismiss}
                      className="min-h-10 px-3 text-[12px] text-muted"
                    >
                      {t('invitations.saved')}
                    </button>
                  </div>
                </>
              ) : (
                <div className="mt-4 flex flex-wrap gap-2">
                  {created.invite.status === 'active' ||
                  created.invite.status === 'suspended' ? (
                    <button
                      type="button"
                      disabled={Boolean(pending)}
                      onClick={() => onRevoke(created.invite.id)}
                      className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-hairline bg-canvas px-3 text-[12px] font-medium disabled:opacity-40"
                    >
                      <X size={14} />
                      {t('invitations.revokeAndRelease')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={onDismiss}
                    className="min-h-10 px-3 text-[12px] text-muted"
                  >
                    {t('invitations.dismiss')}
                  </button>
                </div>
              )}
            </section>
          ) : null}

          <section
            aria-labelledby="invitation-list"
            className="overflow-hidden rounded-2xl border border-hairline bg-surface-raised"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline p-5">
              <div>
                <h2 id="invitation-list" className="text-sm font-semibold">
                  {t('invitations.listTitle')}
                </h2>
                <p className="mt-1 text-[11px] leading-5 text-muted">
                  {t('invitations.totalSlots', { count: summary.total_slots })}
                </p>
              </div>
              <button
                type="button"
                onClick={onGenerate}
                disabled={
                  loading ||
                  Boolean(pending) ||
                  !canGenerate ||
                  Boolean(created)
                }
                className="btn-tactile-primary inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg px-3 text-[12px] font-medium text-on-primary disabled:bg-surface-card disabled:text-muted disabled:opacity-70"
              >
                {pending === 'create' ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Plus size={14} />
                )}
                {t(
                  retrying ? 'invitations.retryCreate' : 'invitations.generate',
                )}
              </button>
            </div>
            {actionError ? (
              <p role="alert" className="px-5 pt-4 text-[12px] text-error">
                {actionError}
              </p>
            ) : null}
            {summary.invitations.length === 0 ? (
              <p className="px-5 py-9 text-center text-[12px] leading-6 text-muted">
                {t('invitations.empty')}
              </p>
            ) : (
              <ul className="divide-y divide-hairline">
                {summary.invitations.map((invite) => (
                  <li
                    key={invite.id}
                    className="flex items-center justify-between gap-3 px-5 py-4"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[13px]">
                          •••• {invite.code_suffix}
                        </span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] ${invite.status === 'active' ? 'bg-primary/10 text-primary' : 'bg-surface-card text-muted'}`}
                        >
                          {t(`invitations.status.${invite.status}`)}
                        </span>
                      </div>
                      <p className="mt-1.5 text-[11px] leading-5 text-muted">
                        {invite.status === 'used' && invite.used_at
                          ? t('invitations.usedAt', {
                              date: date(invite.used_at),
                            })
                          : t('invitations.expiresAt', {
                              date: date(invite.expires_at),
                            })}
                      </p>
                    </div>
                    {invite.status === 'active' ||
                    invite.status === 'suspended' ? (
                      <button
                        type="button"
                        disabled={Boolean(pending) || loading}
                        onClick={() => onRevoke(invite.id)}
                        className="inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-lg border border-hairline px-3 text-[12px] text-muted transition-colors hover:text-ink disabled:opacity-40"
                      >
                        {pending === invite.id ? (
                          <Loader2 size={13} className="animate-spin" />
                        ) : null}
                        {t('invitations.revoke')}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <p className="text-[11px] leading-6 text-muted">
            {t('invitations.slotRules')}
          </p>
        </>
      ) : null}
    </div>
  );
}
