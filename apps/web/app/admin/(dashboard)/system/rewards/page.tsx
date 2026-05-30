'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  admin,
  type AdminRechargePaymentConfig,
  type AdminRewardConfig,
} from '@/lib/admin-api';
import { RefreshCw, WalletCards } from 'lucide-react';
import { RechargeConfigPanel } from '../recharge-config-panel';
import { RewardConfigPanel } from '../reward-config-panel';

/**
 * 后台软妹币配置页面，负责充值和每日签到奖励维护。
 */
export default function AdminRewardConfigPage() {
  const [rechargeConfig, setRechargeConfig] =
    useState<AdminRechargePaymentConfig | null>(null);
  const [rewardConfig, setRewardConfig] = useState<AdminRewardConfig | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [nextRechargeConfig, nextRewardConfig] = await Promise.all([
        admin.rechargeConfig(),
        admin.rewardConfig(),
      ]);
      setRechargeConfig(nextRechargeConfig);
      setRewardConfig(nextRewardConfig);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const withBusy = useCallback(
    async (id: string, fn: () => Promise<void>) => {
      setBusyId(id);
      setError('');
      try {
        await fn();
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : '操作失败');
      } finally {
        setBusyId('');
      }
    },
    [load],
  );

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-transparent" />
      </div>
    );
  }

  if (!rechargeConfig || !rewardConfig) {
    return (
      <div className="py-20 text-center text-[13px] text-error">
        {error || '加载失败'}
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <WalletCards size={16} className="text-muted" />
            <h2 className="text-lg font-semibold">软妹币配置</h2>
          </div>
          <p className="mt-1 text-[13px] leading-6 text-muted">
            管理充值能力和每日签到软妹币奖励。
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="inline-flex h-10 items-center gap-2 self-start rounded-lg border border-hairline px-3 text-[13px] text-muted hover:text-ink"
          title="刷新"
        >
          <RefreshCw size={13} />
          刷新
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-error/30 bg-error/8 px-4 py-3 text-[13px] text-error">
          {error}
        </div>
      )}

      <RewardConfigPanel
        config={rewardConfig}
        busy={busyId === 'reward-config'}
        onSave={async (draft) =>
          withBusy('reward-config', async () => {
            const saved = await admin.updateRewardConfig(draft);
            setRewardConfig(saved);
          })
        }
      />

      <RechargeConfigPanel
        config={rechargeConfig}
        busy={busyId === 'recharge-config'}
        onSave={async (draft) =>
          withBusy('recharge-config', async () => {
            const saved = await admin.updateRechargeConfig(draft);
            setRechargeConfig(saved);
          })
        }
      />
    </div>
  );
}
