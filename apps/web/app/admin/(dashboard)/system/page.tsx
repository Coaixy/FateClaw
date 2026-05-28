'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  admin,
  type AdminRechargePaymentConfig,
  type AdminSystemConfigOverview,
} from '@/lib/admin-api';
import { RefreshCw, Settings2 } from 'lucide-react';
import {
  ProviderCreatePanel,
  ProviderRow,
  RuntimeSummary,
} from './model-provider-panels';
import {
  buildSuggestedProviderKey,
  createEmptyDraft,
  type ProviderDraft,
} from './provider-draft';
import { RechargeConfigPanel } from './recharge-config-panel';

export default function AdminSystemConfigPage() {
  const [overview, setOverview] = useState<AdminSystemConfigOverview | null>(
    null,
  );
  const [rechargeConfig, setRechargeConfig] =
    useState<AdminRechargePaymentConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [newProvider, setNewProvider] =
    useState<ProviderDraft>(createEmptyDraft);
  const [newProviderSecret, setNewProviderSecret] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [data, nextRechargeConfig] = await Promise.all([
        admin.systemConfig(),
        admin.rechargeConfig(),
      ]);
      setOverview(data);
      setRechargeConfig(nextRechargeConfig);
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

  if (!overview) {
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
            <Settings2 size={16} className="text-muted" />
            <h2 className="text-lg font-semibold">系统配置</h2>
          </div>
          <p className="mt-1 text-[13px] leading-6 text-muted">
            管理可供用户显式选择的官方模型池。
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

      <RuntimeSummary overview={overview} provider={null} />

      <ProviderCreatePanel
        draft={newProvider}
        busy={busyId === 'create-provider'}
        secret={newProviderSecret}
        onChange={setNewProvider}
        onSecretChange={setNewProviderSecret}
        onCreate={async () =>
          withBusy('create-provider', async () => {
            await admin.createOfficialModel({
              ...newProvider,
              model_key:
                newProvider.model_key || buildSuggestedProviderKey(newProvider),
              base_url: newProvider.base_url || null,
              api_key: newProviderSecret.trim() || undefined,
            });
            setNewProvider(createEmptyDraft());
            setNewProviderSecret('');
          })
        }
      />

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold">模型提供商</div>
            <div className="mt-1 text-[12px] text-muted">
              用户只能选择启用且已保存密钥的官方模型。
            </div>
          </div>
          <div className="rounded-full bg-canvas px-2.5 py-1 text-[11px] text-muted">
            {overview.providers.length} 个模型
          </div>
        </div>

        {overview.providers.length > 0 ? (
          <div className="space-y-3">
            <div className="hidden gap-3 px-4 text-[10px] uppercase tracking-[0.14em] text-muted xl:grid xl:grid-cols-[minmax(0,1fr)_220px]">
              <div className="grid grid-cols-[minmax(160px,1.2fr)_minmax(140px,0.8fr)_minmax(140px,1fr)_minmax(96px,0.75fr)_16px] gap-3">
                <div>模型</div>
                <div>协议类型</div>
                <div>模型</div>
                <div>Base URL</div>
                <div />
              </div>
              <div className="text-right">状态 / 操作</div>
            </div>
            {overview.providers.map((provider) => (
              <ProviderRow
                key={provider.id}
                provider={provider}
                busy={busyId === provider.id}
                isActive={false}
                onSave={async (id, draft) =>
                  withBusy(id, async () => {
                    await admin.updateOfficialModel(id, {
                      ...draft,
                      model_key:
                        draft.model_key || buildSuggestedProviderKey(draft),
                      base_url: draft.base_url || null,
                    });
                  })
                }
                onSaveSecret={async (id, secret) =>
                  withBusy(id, async () => {
                    await admin.setOfficialModelSecret(id, {
                      api_key: secret,
                    });
                  })
                }
                onSetDefault={async () => undefined}
                onDelete={async (id) =>
                  withBusy(id, async () => {
                    await admin.deleteOfficialModel(id);
                  })
                }
              />
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-hairline bg-surface-card px-4 py-6 text-[13px] text-muted">
            还没有官方模型。
          </div>
        )}
      </section>
    </div>
  );
}
