'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { accountsApi, type Account } from '@/features/accounts/api';
import { billingApi, type BillingStatus } from '@/features/billing/api';
import { hasWechatClawEntitlement } from '@/features/billing/membership-plans';
import { useAccounts } from '@/features/accounts/hooks/use-accounts';
import { useDeviceBinding } from '@/features/accounts/hooks/use-device-binding';
import { useToast } from '@/lib/use-toast';
import { useConfirm } from '@/lib/use-confirm';
import { useI18n } from '@/lib/i18n';
import { AlertTriangle, Plus, Smartphone, RefreshCw, Lock } from 'lucide-react';
import { DeviceCard } from '@/components/workspace/device-card';
import { DeviceBindSheet } from '@/components/workspace/device-bind-sheet';
import { EmptyState } from '@/components/ui/empty-state';

function sortAccounts(list: Account[]): Account[] {
  return [...list];
}

type MembershipStatus = BillingStatus['membership'];

export function DevicesPanel({ embedded = false }: { embedded?: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const { formatNumber, t } = useI18n();
  const [membership, setMembership] = useState<MembershipStatus | null>(null);
  const [membershipLoading, setMembershipLoading] = useState(true);
  const [membershipError, setMembershipError] = useState<string | null>(null);

  const notify = useCallback(
    (type: 'success' | 'error', text: string) => toast(type, text),
    [toast],
  );
  const { accountList, loading, refreshing, loadError, load, refresh } =
    useAccounts();
  const binding = useDeviceBinding(load);
  const deviceAccounts = accountList;
  const membershipActive = hasWechatClawEntitlement(membership);
  const bindingLimitReached = deviceAccounts.length >= 1;
  const canBindWeixin =
    membershipActive && !bindingLimitReached && !membershipLoading;
  const canOpenMembership =
    Boolean(membership?.enabled) &&
    !membershipActive &&
    !membershipLoading &&
    !membershipError;

  useEffect(() => {
    let cancelled = false;
    setMembershipLoading(true);
    setMembershipError(null);
    billingApi
      .status()
      .then((result) => {
        if (cancelled) return;
        setMembership(result.membership);
      })
      .catch((err) => {
        if (cancelled) return;
        setMembershipError(
          err instanceof Error
            ? err.message
            : t('pages.devices.membershipLoadFailed'),
        );
        setMembership(null);
      })
      .finally(() => {
        if (!cancelled) setMembershipLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const bindStatusText = membershipLoading
    ? t('pages.devices.statusLoading')
    : membershipError
      ? t('pages.devices.statusUnknown')
      : membershipActive
        ? bindingLimitReached
          ? t('pages.devices.limitReached')
          : t('pages.devices.bindReady')
        : t('pages.devices.plusOnly');

  const bindButtonLabel = membershipLoading
    ? t('pages.devices.confirming')
    : membershipError
      ? t('pages.devices.unavailable')
      : !membership?.enabled
        ? t('pages.devices.notOpen')
        : membershipActive
          ? bindingLimitReached
            ? t('pages.devices.reachedLimit')
            : t('pages.devices.scanBind')
          : t('pages.devices.openMembership');

  const handleBindAction = () => {
    if (canBindWeixin) {
      binding.start();
      return;
    }
    if (canOpenMembership) {
      router.push('/membership');
    }
  };

  const removeAccount = async (acc: Account) => {
    const ok = await confirm({
      title: t('pages.devices.unbindTitle'),
      message: t('pages.devices.unbindMessage', { name: acc.name }),
      confirmLabel: t('pages.devices.unbindConfirm'),
      variant: 'danger',
    });
    if (!ok) return;
    try {
      await accountsApi.remove(acc.id);
      await load();
      notify('success', t('pages.devices.unbound', { name: acc.name }));
    } catch (err) {
      notify(
        'error',
        err instanceof Error ? err.message : t('pages.devices.unbindFailed'),
      );
    }
  };

  return (
    <>
      <div
        className={`flex items-center justify-between gap-3 relative z-10 ${embedded ? 'mb-4 flex-wrap' : 'mb-5 sm:mb-8'}`}
      >
        {embedded ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center h-8 px-3 rounded-full border border-hairline bg-canvas/60 text-[12px] font-medium text-ink">
              {t('pages.common.countDevices', {
                count: formatNumber(deviceAccounts.length),
              })}
            </span>
            <span className="text-[12px] text-muted">{bindStatusText}</span>
          </div>
        ) : (
          <div className="hidden lg:block">
            <h2 className="text-xl sm:text-2xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-ink to-muted">
              {t('pages.devices.title')}
            </h2>
            <p className="text-[12px] text-muted font-medium mt-0.5">
              {t('pages.common.countDevices', {
                count: formatNumber(deviceAccounts.length),
              })}{' '}
              · {bindStatusText}
            </p>
          </div>
        )}
        <div
          className={`flex items-center gap-2 ${embedded ? 'w-full sm:w-auto justify-end' : 'lg:gap-3 ml-auto'}`}
        >
          <button
            onClick={refresh}
            disabled={refreshing || loading}
            className={`flex items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--color-surface-card)_60%,transparent)] border border-hairline/50 backdrop-blur-sm text-muted hover:text-ink hover:border-hairline hover:bg-surface-cream-strong disabled:opacity-30 transition-all duration-300 shadow-sm cursor-pointer group ${embedded ? 'w-9 h-9' : 'w-10 h-10'}`}
            aria-label={t('pages.devices.refreshData')}
          >
            <RefreshCw
              size={embedded ? 14 : 16}
              className={`transition-transform duration-500 ${refreshing ? 'animate-spin' : 'group-hover:rotate-180'}`}
              strokeWidth={2.5}
            />
          </button>
          <button
            onClick={handleBindAction}
            disabled={loading || (!canBindWeixin && !canOpenMembership)}
            className={`flex items-center justify-center gap-2 rounded-xl bg-primary text-on-primary font-bold hover:bg-primary-active transition-all duration-200 cursor-pointer disabled:cursor-not-allowed disabled:opacity-45 ${embedded ? 'h-9 px-4 text-[13px]' : 'h-10 px-6 text-[14px]'}`}
          >
            {canBindWeixin ? (
              <Plus size={16} strokeWidth={2.5} />
            ) : (
              <Lock size={16} strokeWidth={2.5} />
            )}
            <span>{bindButtonLabel}</span>
          </button>
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 sm:gap-4">
          {[1, 2].map((i) => (
            <div
              key={i}
              className="h-[100px] rounded-2xl border border-hairline/50 bg-[color-mix(in_srgb,var(--color-surface-card)_50%,transparent)] animate-pulse"
            />
          ))}
        </div>
      ) : loadError ? (
        <div className="rounded-[32px] border border-dashed border-hairline bg-[color-mix(in_srgb,var(--color-surface-card)_30%,transparent)] backdrop-blur-sm">
          <EmptyState
            icon={AlertTriangle}
            title={t('pages.devices.loadFailed')}
            description={loadError}
            action={{
              label: t('pages.devices.reload'),
              onClick: () => void load(),
            }}
          />
        </div>
      ) : deviceAccounts.length > 0 ? (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 sm:gap-4">
          {sortAccounts(deviceAccounts).map((acc) => (
            <DeviceCard
              key={acc.id}
              account={acc}
              onRemove={() => void removeAccount(acc)}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-[32px] border border-dashed border-hairline bg-[color-mix(in_srgb,var(--color-surface-card)_30%,transparent)] backdrop-blur-sm p-12 text-center flex flex-col items-center">
          <div className="w-20 h-20 rounded-3xl bg-canvas/50 border border-hairline/50 flex items-center justify-center mb-6 shadow-[inset_0_0_20px_rgba(0,0,0,0.2)]">
            <Smartphone
              size={32}
              strokeWidth={1.5}
              className="text-muted opacity-70"
            />
          </div>
          <h3 className="text-[18px] font-bold mb-2 tracking-tight">
            {membershipLoading
              ? t('pages.devices.emptyLoadingTitle')
              : membershipActive
                ? t('pages.devices.emptyActiveTitle')
                : t('pages.devices.emptyPlusTitle')}
          </h3>
          <p className="text-[14px] text-muted mb-8 max-w-sm leading-relaxed">
            {membershipLoading
              ? t('pages.devices.emptyLoadingDescription')
              : membershipError
                ? t('pages.devices.emptyUnknownDescription')
                : membershipActive
                  ? t('pages.devices.emptyActiveDescription')
                  : t('pages.devices.emptyPlusDescription')}
          </p>
          <button
            onClick={handleBindAction}
            disabled={loading || (!canBindWeixin && !canOpenMembership)}
            className="inline-flex items-center gap-2 h-12 px-8 rounded-xl bg-primary text-on-primary text-[14px] font-bold hover:bg-primary-active transition-all duration-200 cursor-pointer disabled:cursor-not-allowed disabled:opacity-45"
          >
            {canBindWeixin ? (
              <Plus size={18} strokeWidth={2.5} />
            ) : (
              <Lock size={18} strokeWidth={2.5} />
            )}
            {bindButtonLabel}
          </button>
        </div>
      )}

      <DeviceBindSheet
        open={binding.showModal}
        bindStep={binding.bindStep}
        qrUrl={binding.qrUrl}
        bindError={binding.bindError}
        onClose={binding.stop}
        onRetry={() => void binding.start()}
      />
    </>
  );
}
