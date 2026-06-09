'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { accountsApi, type Account } from '@/features/accounts/api';
import { billingApi, type BillingStatus } from '@/features/billing/api';
import { useAccounts } from '@/features/accounts/hooks/use-accounts';
import { useDeviceBinding } from '@/features/accounts/hooks/use-device-binding';
import { useToast } from '@/lib/use-toast';
import { useConfirm } from '@/lib/use-confirm';
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
  const membershipActive = Boolean(membership?.enabled && membership.active);
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
          err instanceof Error ? err.message : '会员状态加载失败',
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
    ? '正在确认会员状态'
    : membershipError
      ? '会员状态暂时无法确认'
      : membershipActive
        ? bindingLimitReached
          ? '会员最多绑定 1 个微信 Claw'
          : 'FateClaw Plus 可扫码绑定微信 Claw'
        : '微信 Claw 仅 FateClaw Plus 会员可绑定';

  const bindButtonLabel = membershipLoading
    ? '确认中'
    : membershipError
      ? '暂不可用'
      : !membership?.enabled
        ? '暂未开放'
        : membershipActive
        ? bindingLimitReached
          ? '已达上限'
          : '扫码接入'
        : '开通会员';

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
      title: '解除绑定',
      message: `确定要解除「${acc.name}」的绑定吗？\n\n该设备的对话消息将被立即且永久删除。`,
      confirmLabel: '解除绑定',
      variant: 'danger',
    });
    if (!ok) return;
    try {
      await accountsApi.remove(acc.id);
      await load();
      notify('success', `「${acc.name}」已解除绑定`);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : '解绑失败');
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
              {deviceAccounts.length}
              台设备
            </span>
            <span className="text-[12px] text-muted">{bindStatusText}</span>
          </div>
        ) : (
          <div className="hidden lg:block">
            <h2 className="text-xl sm:text-2xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-ink to-muted">
              宿主设备
            </h2>
            <p className="text-[12px] text-muted font-medium mt-0.5">
              {deviceAccounts.length}
              台接入 · {bindStatusText}
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
            aria-label="刷新数据"
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
            title="设备列表加载失败"
            description={loadError}
            action={{ label: '重新加载', onClick: () => void load() }}
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
              ? '正在确认会员状态'
              : membershipActive
                ? '尚未接入微信设备'
                : '微信 Claw 会员专属'}
          </h3>
          <p className="text-[14px] text-muted mb-8 max-w-sm leading-relaxed">
            {membershipLoading
              ? '会员状态确认完成后，Plus 会员可扫码绑定微信 Claw。'
              : membershipError
                ? '会员状态暂时无法确认，请稍后刷新后重试；站内 AI Chat 和手动排盘仍可继续使用。'
                : membershipActive
                  ? '使用移动端微信扫码绑定微信 Claw，绑定后即可在微信中进行文本对话。'
                  : '开通 FateClaw Plus 后可扫码绑定微信 Claw；站内 AI Chat 和手动排盘仍可继续使用。'}
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
