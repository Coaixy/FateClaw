'use client';

import { useCallback, useState } from 'react';
import { accountsApi, type Account } from '@/features/accounts/api';
import { useAccountSoul } from '@/features/accounts/hooks/use-account-soul';
import { useAccounts } from '@/features/accounts/hooks/use-accounts';
import { useDeviceBinding } from '@/features/accounts/hooks/use-device-binding';
import { useToast } from '@/lib/use-toast';
import { useConfirm } from '@/lib/use-confirm';
import {
  AlertTriangle,
  Plus,
  Smartphone,
  RefreshCw,
  Lock,
} from 'lucide-react';
import { soulPresets, SoulPreset } from '@/lib/soul-presets';
import { DeviceCard } from '@/components/workspace/device-card';
import { DeviceBindSheet } from '@/components/workspace/device-bind-sheet';
import { SoulPresetSheet } from '@/components/workspace/soul-preset-sheet';
import { EmptyState } from '@/components/ui/empty-state';

function sortAccounts(list: Account[]): Account[] {
  return [...list];
}

export function DevicesPanel({ embedded = false }: { embedded?: boolean }) {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const [previewPreset, setPreviewPreset] = useState<SoulPreset | null>(null);

  const notify = useCallback(
    (type: 'success' | 'error', text: string) => toast(type, text),
    [toast],
  );
  const { accountList, loading, refreshing, loadError, load, refresh } =
    useAccounts();
  const binding = useDeviceBinding(load);
  const soul = useAccountSoul(notify);
  const deviceAccounts = accountList;
  const canBindWeixin = false;

  const removeAccount = async (acc: Account) => {
    const ok = await confirm({
      title: '解除绑定',
      message: `确定要解除「${acc.name}」的绑定吗？\n\n所有对话消息、灵魂记忆和相关的定时任务将被立即且永久删除。`,
      confirmLabel: '解除绑定',
      variant: 'danger',
    });
    if (!ok) return;
    try {
      await accountsApi.remove(acc.id);
      soul.collapseIfExpanded(acc.id);
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
            <span className="text-[12px] text-muted">
              微信绑定暂时关闭，已有绑定数据已清空
            </span>
          </div>
        ) : (
          <div className="hidden lg:block">
            <h2 className="text-xl sm:text-2xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-ink to-muted">
              宿主设备
            </h2>
            <p className="text-[12px] text-muted font-medium mt-0.5">
              {deviceAccounts.length}
              台接入 · 配置灵魂记忆与 System Prompt
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
            onClick={binding.start}
            disabled={!canBindWeixin}
            className={`flex items-center justify-center gap-2 rounded-xl bg-primary text-on-primary font-bold hover:bg-primary-active transition-all duration-200 cursor-pointer disabled:cursor-not-allowed disabled:opacity-45 ${embedded ? 'h-9 px-4 text-[13px]' : 'h-10 px-6 text-[14px]'}`}
          >
            <Plus size={16} strokeWidth={2.5} />
            <span>暂未开放</span>
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
              expanded={soul.expandedSoul === acc.id}
              soulContent={soul.expandedSoul === acc.id ? soul.soulContent : ''}
              soulLoading={soul.expandedSoul === acc.id && soul.soulLoading}
              soulSaving={soul.expandedSoul === acc.id && soul.soulSaving}
              soulDirty={soul.expandedSoul === acc.id && soul.soulDirty}
              soulPresets={soulPresets}
              onToggle={() => void soul.toggleSoul(acc.id)}
              onRemove={() => void removeAccount(acc)}
              onOpenPreset={setPreviewPreset}
              onSoulChange={soul.setSoulContent}
              onSaveSoul={() => void soul.saveSoul()}
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
            微信设备暂时关闭
          </h3>
          <p className="text-[14px] text-muted mb-8 max-w-sm leading-relaxed">
            站内 AI Chat 和手动排盘仍可使用；微信扫码绑定、已有账号绑定和后台运行入口已暂时关闭。
          </p>
          <button
            onClick={binding.start}
            disabled={!canBindWeixin}
            className="inline-flex items-center gap-2 h-12 px-8 rounded-xl bg-primary text-on-primary text-[14px] font-bold hover:bg-primary-active transition-all duration-200 cursor-pointer disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Lock size={18} strokeWidth={2.5} />
            暂未开放
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

      <SoulPresetSheet
        preset={previewPreset}
        onClose={() => setPreviewPreset(null)}
        onApply={() => {
          if (!previewPreset) return;
          if (!soul.expandedSoul) {
            notify('error', '请先展开一个账号的灵魂记忆面板再载入');
            return;
          }
          soul.setSoulContent(previewPreset.content);
          setPreviewPreset(null);
          notify('success', `已载入「${previewPreset.name}」配置片段`);
        }}
      />
    </>
  );
}
