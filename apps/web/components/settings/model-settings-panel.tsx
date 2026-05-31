'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Check,
  Loader2,
  MessageSquareText,
  RefreshCw,
  Save,
  ServerCog,
  Sparkles,
} from 'lucide-react';

import {
  modelSettingsApi,
  type ModelPiApi,
  type ModelSettingsOverview,
  type OfficialModel,
  type UserModelSelection,
} from '@/features/model-settings/api';
import { PI_API_OPTIONS } from '../../features/model-settings/pi-api-options';
import { OfficialModelPriceTags } from './official-model-price-tags';
import {
  customModelPlatformFeeAmountLabel,
  customModelPlatformFeeLabel,
  DEFAULT_CUSTOM_MODEL_PLATFORM_PRICE_PER_MILLION_COINS,
  findLowestPricedOfficialModel,
} from './model-pricing';

const CONTROL =
  'h-11 w-full rounded-lg border border-hairline bg-canvas px-3 text-sm outline-none focus:border-hairline';

type CustomDraft = {
  pi_api: ModelPiApi;
  base_url: string;
  model_name: string;
  context_window_tokens: number;
};

function customDraftFromOverview(data: ModelSettingsOverview): CustomDraft {
  return {
    pi_api: data.custom?.pi_api ?? 'openai-completions',
    base_url: data.custom?.base_url ?? '',
    model_name: data.custom?.model_name ?? '',
    context_window_tokens: data.custom?.context_window_tokens ?? 0,
  };
}

function hasUsableCustomModel(data: ModelSettingsOverview): boolean {
  return Boolean(data.custom?.model_name.trim() && data.custom.has_secret);
}

function hasUsableOfficialSelection(data: ModelSettingsOverview): boolean {
  const selectedId = data.selection?.official_model_id;
  return Boolean(
    selectedId &&
      data.official_models.some(
        (model) => model.id === selectedId && model.enabled && model.has_secret,
      ),
  );
}

function resolveDefaultOfficialModel(
  data: ModelSettingsOverview,
): OfficialModel | null {
  const defaultOfficialModel = findLowestPricedOfficialModel(
    data.official_models,
  );
  if (!defaultOfficialModel) {
    return null;
  }
  if (data.selection?.source === 'custom' && hasUsableCustomModel(data)) {
    return null;
  }
  if (data.selection?.source === 'official' && hasUsableOfficialSelection(data)) {
    return null;
  }
  // 未选择、所选模型失效、或自配模型不可用时，界面展示后端实际会使用的官方兜底。
  return defaultOfficialModel;
}

function buildDefaultOfficialSelection(
  data: ModelSettingsOverview,
  model: OfficialModel,
): UserModelSelection {
  return {
    user_id: data.selection?.user_id ?? data.custom?.user_id ?? '',
    source: 'official',
    official_model_id: model.id,
    created_at: data.selection?.created_at ?? '',
    updated_at: data.selection?.updated_at ?? '',
  };
}

export function ModelSettingsPanel() {
  const [overview, setOverview] = useState<ModelSettingsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [custom, setCustom] = useState<CustomDraft>({
    pi_api: 'openai-completions',
    base_url: '',
    model_name: '',
    context_window_tokens: 0,
  });
  const [secret, setSecret] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setMessage('');
    try {
      const data = await modelSettingsApi.overview();
      let nextOverview = data;
      let defaultSelectionMessage = '';
      const defaultOfficialModel = resolveDefaultOfficialModel(data);
      if (defaultOfficialModel) {
        nextOverview = {
          ...data,
          selection: buildDefaultOfficialSelection(data, defaultOfficialModel),
        };
        defaultSelectionMessage = `默认使用价格最低的官方模型：${defaultOfficialModel.display_name}`;
      }
      setOverview(nextOverview);
      setCustom(customDraftFromOverview(nextOverview));
      if (defaultSelectionMessage) {
        setMessage(defaultSelectionMessage);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '加载模型设置失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveCustom = async () => {
    setBusy('custom');
    setMessage('');
    const nextSecret = secret.trim();
    try {
      await modelSettingsApi.saveCustom({
        pi_api: custom.pi_api,
        base_url: custom.base_url.trim() || null,
        model_name: custom.model_name.trim(),
        context_window_tokens: custom.context_window_tokens || null,
        api_key: nextSecret || undefined,
      });
      setSecret('');
      setMessage('自配模型已保存');
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败');
    } finally {
      setBusy('');
    }
  };

  const selectOfficial = async (modelId: string) => {
    setBusy(modelId);
    setMessage('');
    try {
      await modelSettingsApi.select({
        source: 'official',
        official_model_id: modelId,
      });
      setMessage('已选择官方模型');
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '选择失败');
    } finally {
      setBusy('');
    }
  };

  const selectCustom = async () => {
    setBusy('select-custom');
    setMessage('');
    try {
      await modelSettingsApi.select({ source: 'custom' });
      setMessage('已选择自配模型');
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '选择失败');
    } finally {
      setBusy('');
    }
  };

  if (loading) {
    return (
      <div className="rounded-lg border border-hairline bg-surface-card px-4 py-8 text-center text-[13px] text-muted">
        加载中…
      </div>
    );
  }

  const selection = overview?.selection;
  const customModelPlatformFeeCoins =
    overview?.custom_model_platform_price_per_million_coins ??
    DEFAULT_CUSTOM_MODEL_PLATFORM_PRICE_PER_MILLION_COINS;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">模型设置</div>
          <div className="mt-1 text-[12px] text-muted">
            未选择或当前选择失效时，会默认使用价格最低的可用官方模型。
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-hairline px-3 text-[12px] text-muted hover:text-ink"
        >
          <RefreshCw size={13} />
          刷新
        </button>
      </div>

      {message && (
        <div className="rounded-lg border border-hairline bg-surface-card px-3 py-2 text-[12px] text-muted">
          {message}
        </div>
      )}

      <CustomModelSection
        busy={busy}
        custom={custom}
        customModelPlatformFeeCoins={customModelPlatformFeeCoins}
        hasSecret={Boolean(overview?.custom?.has_secret)}
        secret={secret}
        selected={selection?.source === 'custom'}
        setCustom={setCustom}
        setSecret={setSecret}
        onSaveCustom={saveCustom}
        onSelectCustom={selectCustom}
      />

      <OfficialModelsSection
        busy={busy}
        models={overview?.official_models ?? []}
        selection={selection ?? null}
        onSelectOfficial={selectOfficial}
      />
    </div>
  );
}

function CustomModelSection({
  busy,
  custom,
  customModelPlatformFeeCoins,
  hasSecret,
  secret,
  selected,
  setCustom,
  setSecret,
  onSaveCustom,
  onSelectCustom,
}: {
  busy: string;
  custom: CustomDraft;
  customModelPlatformFeeCoins: number;
  hasSecret: boolean;
  secret: string;
  selected: boolean;
  setCustom: React.Dispatch<React.SetStateAction<CustomDraft>>;
  setSecret: (value: string) => void;
  onSaveCustom: () => Promise<void>;
  onSelectCustom: () => Promise<void>;
}) {
  return (
    <section className="rounded-lg border border-hairline bg-surface-card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <ServerCog size={15} className="text-muted" />
          自配模型
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="rounded-full bg-primary/10 px-2 py-1 text-[10px] font-medium text-primary">
            {customModelPlatformFeeLabel(customModelPlatformFeeCoins)}
          </span>
          <span className="rounded-full bg-canvas px-2 py-1 text-[10px] text-muted">
            {hasSecret ? '已保存密钥' : '未保存密钥'}
          </span>
        </div>
      </div>
      <div className="mb-3 rounded-lg border border-hairline/70 bg-canvas/55 px-3 py-2 text-[12px] leading-5 text-muted">
        模型商原始费用由你的供应商账号收取；网站统一按输入与输出 Token
        合计收取平台服务费，每百万 Token{' '}
        {customModelPlatformFeeAmountLabel(customModelPlatformFeeCoins)}。
      </div>
      <CustomModelFields
        custom={custom}
        setCustom={setCustom}
      />
      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
        <input
          type="password"
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
          placeholder={
            hasSecret
              ? '留空则继续使用已保存密钥'
              : '输入 API Key'
          }
          className={CONTROL}
        />
        <button
          type="button"
          onClick={() => void onSaveCustom()}
          disabled={
            busy === 'custom' ||
            !custom.model_name.trim() ||
            (!hasSecret && !secret.trim())
          }
          className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-on-primary disabled:opacity-40"
        >
          {busy === 'custom' ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Save size={14} />
          )}
          保存模型
        </button>
      </div>
      <button
        type="button"
        onClick={() => void onSelectCustom()}
        disabled={busy === 'select-custom'}
        className={`mt-3 inline-flex h-10 items-center gap-2 rounded-lg px-3 text-[13px] ${
          selected
            ? 'bg-primary/15 text-primary'
            : 'border border-hairline text-muted hover:text-ink'
        }`}
      >
        <Check size={14} />
        {selected ? '当前选择自配模型' : '选择自配模型'}
      </button>
    </section>
  );
}

function CustomModelFields({
  custom,
  setCustom,
}: {
  custom: CustomDraft;
  setCustom: React.Dispatch<React.SetStateAction<CustomDraft>>;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="space-y-1.5">
        <span className="text-[12px] font-medium text-muted">
          协议类型
        </span>
        <select
          value={custom.pi_api}
          onChange={(event) =>
            setCustom((prev) => ({
              ...prev,
              pi_api: event.target.value as ModelPiApi,
            }))
          }
          className={CONTROL}
        >
          {PI_API_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <TextField
        label="模型名"
        value={custom.model_name}
        onChange={(value) =>
          setCustom((prev) => ({ ...prev, model_name: value }))
        }
      />
      <TextField
        label="上下文窗口 Token（0 为自动）"
        value={String(custom.context_window_tokens)}
        onChange={(value) =>
          setCustom((prev) => ({
            ...prev,
            context_window_tokens: Number.parseInt(value || '0', 10) || 0,
          }))
        }
      />
      <TextField
        label="Base URL"
        value={custom.base_url}
        placeholder="可选"
        onChange={(value) =>
          setCustom((prev) => ({ ...prev, base_url: value }))
        }
      />
    </div>
  );
}

function OfficialModelsSection({
  busy,
  models,
  selection,
  onSelectOfficial,
}: {
  busy: string;
  models: OfficialModel[];
  selection: ModelSettingsOverview['selection'];
  onSelectOfficial: (modelId: string) => Promise<void>;
}) {
  return (
    <section className="space-y-3">
      <div>
        <div className="flex items-center gap-2 text-[12px] font-medium text-muted">
          <Sparkles size={13} className="text-primary" />
          官方模型
        </div>
        <div className="mt-1 text-[12px] leading-5 text-muted">
          由平台统一维护密钥和扣费价格，适合不想自行配置供应商账号的用户。
        </div>
      </div>
      {models.length === 0 ? (
        <div className="rounded-lg border border-hairline bg-surface-card px-4 py-6 text-[13px] text-muted">
          管理员尚未配置官方模型。
        </div>
      ) : (
        <div className="grid gap-2">
          {models.map((model) => (
            <OfficialModelOption
              key={model.id}
              busy={busy === model.id}
              model={model}
              selected={
                selection?.source === 'official' &&
                selection.official_model_id === model.id
              }
              onSelect={() => onSelectOfficial(model.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function OfficialModelOption({
  busy,
  model,
  selected,
  onSelect,
}: {
  busy: boolean;
  model: OfficialModel;
  selected: boolean;
  onSelect: () => Promise<void>;
}) {
  const available = model.enabled && model.has_secret;
  const description =
    model.description ||
    '管理员尚未填写说明，可根据展示名称和价格选择。';
  return (
    <button
      type="button"
      onClick={() => void onSelect()}
      disabled={!available || busy}
      className={`rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        selected
          ? 'border-primary bg-primary/10 shadow-[0_8px_18px_rgba(0,0,0,0.06)]'
          : 'border-hairline bg-surface-card hover:border-primary/35 hover:bg-surface-cream-strong'
      }`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">
              {model.display_name}
            </span>
            {selected && (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[10px] font-medium text-on-primary">
                <Check size={11} />
                当前
              </span>
            )}
            {!available && (
              <span className="rounded-full bg-canvas px-2 py-0.5 text-[10px] text-muted">
                暂不可用
              </span>
            )}
          </div>
        </div>
        <OfficialModelPriceTags model={model} />
      </div>
      <div className="mt-3 flex items-start gap-2 rounded-lg border border-hairline/70 bg-canvas/55 px-3 py-2 text-[12px] leading-5 text-muted">
        <MessageSquareText size={13} className="mt-0.5 shrink-0 text-muted" />
        <span>{description}</span>
      </div>
    </button>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="space-y-1.5">
      <span className="text-[12px] font-medium text-muted">
        {label}
      </span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={CONTROL}
      />
    </label>
  );
}
