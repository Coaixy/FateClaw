'use client';

import { useEffect, useState } from 'react';
import type {
  AdminModelBillingConfig,
  AdminModelProvider,
  AdminModelPiApi,
  AdminRuntimeConfig,
  AdminSystemConfigOverview,
} from '@/lib/admin-api';
import {
  ChevronDown,
  ChevronUp,
  MessageSquareText,
  Loader2,
  Power,
  PowerOff,
  Save,
  Trash2,
} from 'lucide-react';
import {
  PI_API_OPTIONS,
  protocolTypeLabel,
} from '../../../../features/model-settings/pi-api-options';
import { OfficialModelPriceTags } from '../../../../components/settings/official-model-price-tags';
import {
  customModelPlatformFeeLabel,
  officialModelCoinsLabel,
} from '../../../../components/settings/model-pricing';
import { setProviderDraftEnabled, type ProviderDraft } from './provider-draft';

const CONTROL =
  'h-11 w-full rounded-lg border border-hairline bg-canvas px-3 text-sm focus:border-hairline focus:outline-none';

function providerDraftFrom(model: AdminModelProvider): ProviderDraft {
  return {
    model_key: model.model_key,
    pi_api: model.pi_api,
    display_name: model.display_name,
    description: model.description || '',
    enabled: model.enabled,
    priority: model.priority,
    base_url: model.base_url || '',
    model_name: model.model_name,
    api_key: model.api_key || '',
    context_window_tokens: model.context_window_tokens ?? 0,
    input_token_price_per_million_coins:
      model.input_token_price_per_million_coins,
    output_token_price_per_million_coins:
      model.output_token_price_per_million_coins,
  };
}

export function resolveRuntimeProvider(
  overview: AdminSystemConfigOverview | null,
): AdminModelProvider | null {
  return (
    overview?.providers.find((model) => model.enabled && model.has_secret) ??
    null
  );
}

export function RuntimeSummary({
  overview,
}: {
  overview: AdminSystemConfigOverview;
  provider: AdminModelProvider | null;
}) {
  const availableCount = overview.providers.filter(
    (model) => model.enabled && model.has_secret,
  ).length;
  return (
    <div className="rounded-lg border border-hairline bg-surface-card p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="text-sm font-semibold">官方模型池</div>
          <div className="mt-1 text-[12px] leading-5 text-muted">
            用户未选择、选择失效或自配模型不可用时，系统会回退到价格最低的可用官方模型。
          </div>
        </div>
        <div className="rounded-full bg-canvas px-2.5 py-1 text-[11px] text-muted">
          {availableCount} 个可选模型
        </div>
      </div>
    </div>
  );
}

/**
 * 后台自配模型平台服务费配置面板。
 */
export function ModelBillingPanel({
  billing,
  busy,
  onSave,
}: {
  billing: AdminModelBillingConfig;
  busy: boolean;
  onSave: (coins: number) => Promise<void>;
}) {
  const [price, setPrice] = useState(
    billing.custom_model_platform_price_per_million_coins,
  );

  useEffect(() => {
    setPrice(billing.custom_model_platform_price_per_million_coins);
  }, [billing.custom_model_platform_price_per_million_coins]);

  return (
    <div className="rounded-lg border border-hairline bg-surface-card p-4 sm:p-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="text-sm font-semibold">平台 Token 服务费</div>
          <div className="mt-1 text-[12px] leading-5 text-muted">
            自配模型只收平台服务费；官方模型使用各模型自己的输入/输出单价。
          </div>
          <div className="mt-2 text-[12px] text-muted">
            当前：
            {customModelPlatformFeeLabel(
              billing.custom_model_platform_price_per_million_coins,
            )}
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-[220px_auto]">
          <NumberField
            label="自配模型服务费（软妹币 / 百万 Token）"
            value={price}
            onChange={setPrice}
          />
          <button
            type="button"
            onClick={() => void onSave(price)}
            disabled={
              busy ||
              price === billing.custom_model_platform_price_per_million_coins
            }
            className="inline-flex h-11 items-center justify-center gap-2 self-end rounded-lg bg-primary px-4 text-sm font-medium text-on-primary disabled:opacity-40"
          >
            {busy ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Save size={14} />
            )}
            保存服务费
          </button>
        </div>
      </div>
      <div className="mt-3 text-[11px] text-muted">
        输入和输出 Token 都按 {officialModelCoinsLabel(price)} / 百万 Token
        扣费。
      </div>
    </div>
  );
}

/**
 * 后台 Agent 运行时配置面板。
 */
export function RuntimeConfigPanel({
  runtime,
  busy,
  onSave,
}: {
  runtime: AdminRuntimeConfig;
  busy: boolean;
  onSave: (config: {
    agent_concurrency_limit: number;
    local_agent_max_processes: number;
    local_agent_idle_ttl_ms: number;
    pi_session_health_enabled: boolean;
    pi_session_inactive_cleanup_days: number;
    pi_session_orphan_grace_days: number;
  }) => Promise<void>;
}) {
  const [limit, setLimit] = useState(runtime.agent_concurrency_limit);
  const [maxProcesses, setMaxProcesses] = useState(
    runtime.local_agent_max_processes,
  );
  const [idleSeconds, setIdleSeconds] = useState(
    Math.round(runtime.local_agent_idle_ttl_ms / 1000),
  );
  const [piHealthEnabled, setPiHealthEnabled] = useState(
    runtime.pi_session_health_enabled,
  );
  const [piInactiveDays, setPiInactiveDays] = useState(
    runtime.pi_session_inactive_cleanup_days,
  );
  const [piOrphanGraceDays, setPiOrphanGraceDays] = useState(
    runtime.pi_session_orphan_grace_days,
  );

  useEffect(() => {
    setLimit(runtime.agent_concurrency_limit);
    setMaxProcesses(runtime.local_agent_max_processes);
    setIdleSeconds(Math.round(runtime.local_agent_idle_ttl_ms / 1000));
    setPiHealthEnabled(runtime.pi_session_health_enabled);
    setPiInactiveDays(runtime.pi_session_inactive_cleanup_days);
    setPiOrphanGraceDays(runtime.pi_session_orphan_grace_days);
  }, [
    runtime.agent_concurrency_limit,
    runtime.local_agent_idle_ttl_ms,
    runtime.local_agent_max_processes,
    runtime.pi_session_health_enabled,
    runtime.pi_session_inactive_cleanup_days,
    runtime.pi_session_orphan_grace_days,
  ]);

  const normalized = {
    agent_concurrency_limit: Math.max(1, Math.floor(limit)),
    local_agent_max_processes: Math.min(
      100,
      Math.max(1, Math.floor(maxProcesses)),
    ),
    local_agent_idle_ttl_ms: Math.min(
      86_400_000,
      Math.max(30_000, Math.floor(idleSeconds) * 1000),
    ),
    pi_session_health_enabled: piHealthEnabled,
    pi_session_inactive_cleanup_days: Math.min(
      3650,
      Math.max(1, Math.floor(piInactiveDays)),
    ),
    pi_session_orphan_grace_days: Math.min(
      3650,
      Math.max(1, Math.floor(piOrphanGraceDays)),
    ),
  };
  const dirty =
    normalized.agent_concurrency_limit !== runtime.agent_concurrency_limit ||
    normalized.local_agent_max_processes !==
      runtime.local_agent_max_processes ||
    normalized.local_agent_idle_ttl_ms !== runtime.local_agent_idle_ttl_ms ||
    normalized.pi_session_health_enabled !==
      runtime.pi_session_health_enabled ||
    normalized.pi_session_inactive_cleanup_days !==
      runtime.pi_session_inactive_cleanup_days ||
    normalized.pi_session_orphan_grace_days !==
      runtime.pi_session_orphan_grace_days;

  return (
    <div className="rounded-lg border border-hairline bg-surface-card p-4 sm:p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="text-sm font-semibold">Agent 运行时策略</div>
          <div className="mt-1 text-[12px] leading-5 text-muted">
            控制请求并发、常驻 agent-runtime、空闲回收和 Pi session 自动健康维护。
          </div>
          <div className="mt-2 text-[12px] text-muted">
            当前：{runtime.agent_concurrency_limit} 并发 /{' '}
            {runtime.local_agent_max_processes} runtime /{' '}
            {Math.round(runtime.local_agent_idle_ttl_ms / 1000)} 秒回收 / Pi{' '}
            {runtime.pi_session_health_enabled ? '自动维护' : '手动维护'}
          </div>
        </div>
        <div className="grid gap-2 md:grid-cols-3 lg:min-w-[720px] lg:grid-cols-[1fr_1fr_1fr_auto]">
          <NumberField
            label="全站并发上限"
            value={limit}
            onChange={setLimit}
            min={1}
            max={1000}
          />
          <NumberField
            label="最大常驻 runtime"
            value={maxProcesses}
            onChange={setMaxProcesses}
            min={1}
            max={100}
          />
          <NumberField
            label="空闲回收秒数"
            value={idleSeconds}
            onChange={setIdleSeconds}
            min={30}
            max={86_400}
          />
          <label className="flex h-11 items-center gap-2 rounded-lg border border-hairline bg-canvas px-3 text-[12px] text-muted">
            <input
              type="checkbox"
              checked={piHealthEnabled}
              onChange={(event) => setPiHealthEnabled(event.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            Pi 自动维护
          </label>
          <NumberField
            label="Pi 未活跃天数"
            value={piInactiveDays}
            onChange={setPiInactiveDays}
            min={1}
            max={3650}
          />
          <NumberField
            label="孤儿保护天数"
            value={piOrphanGraceDays}
            onChange={setPiOrphanGraceDays}
            min={1}
            max={3650}
          />
          <button
            type="button"
            onClick={() => void onSave(normalized)}
            disabled={busy || !dirty}
            className="inline-flex h-11 items-center justify-center gap-2 self-end rounded-lg bg-primary px-4 text-sm font-medium text-on-primary disabled:opacity-40 md:col-start-3 lg:col-start-auto"
          >
            {busy ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Save size={14} />
            )}
            保存策略
          </button>
        </div>
      </div>
      <div className="mt-3 text-[11px] text-muted">
        2G 服务器建议使用 1 并发 / 2 runtime / 120 秒回收。
      </div>
    </div>
  );
}

export function ProviderRow({
  provider,
  busy,
  onSave,
  onDelete,
}: {
  provider: AdminModelProvider;
  busy: boolean;
  isActive: boolean;
  onSave: (id: string, draft: ProviderDraft) => Promise<void>;
  onSetDefault: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<ProviderDraft>(() =>
    providerDraftFrom(provider),
  );
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setDraft(providerDraftFrom(provider));
  }, [provider]);

  const toggledDraft = setProviderDraftEnabled(draft, !provider.enabled);
  const description =
    provider.description || '未填写说明，用户侧会显示默认提示。';

  return (
    <div className="rounded-lg border border-hairline bg-surface-card p-4 sm:p-5">
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_220px] xl:items-start">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex min-w-0 cursor-pointer items-start gap-3 text-left"
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-col gap-3 xl:grid xl:grid-cols-[minmax(180px,0.8fr)_minmax(0,1.2fr)] xl:items-start xl:gap-3">
              <div className="min-w-0">
                <div className="truncate text-[14px] font-semibold">
                  {provider.display_name}
                </div>
                <div className="mt-1 flex items-start gap-1.5 text-[11px] leading-4 text-muted xl:hidden">
                  <MessageSquareText size={12} className="mt-0.5 shrink-0" />
                  <span className="line-clamp-2">{description}</span>
                </div>
              </div>
              <div className="text-[12px] text-muted">
                {protocolTypeLabel(provider.pi_api)}
              </div>
            </div>
            <div className="mt-3 hidden items-start gap-1.5 rounded-lg border border-hairline/70 bg-canvas/50 px-3 py-2 text-[11px] leading-5 text-muted xl:flex">
              <MessageSquareText size={12} className="mt-0.5 shrink-0" />
              <span className="line-clamp-2">{description}</span>
            </div>
            <div className="mt-3">
              <OfficialModelPriceTags model={provider} compact />
            </div>
          </div>
          {expanded ? (
            <ChevronUp size={16} className="mt-1 shrink-0 text-muted" />
          ) : (
            <ChevronDown size={16} className="mt-1 shrink-0 text-muted" />
          )}
        </button>

        <div className="flex min-w-0 flex-col gap-2 xl:items-end">
          <div className="flex min-w-0 flex-wrap gap-1.5 xl:justify-end">
            {!provider.enabled && (
              <span className="whitespace-nowrap rounded-full bg-canvas px-2 py-1 text-[10px] text-muted">
                停用
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => void onSave(provider.id, toggledDraft)}
            disabled={busy}
            className={`inline-flex h-10 items-center justify-center gap-1.5 rounded-lg px-3 text-[12px] font-medium disabled:opacity-40 ${
              provider.enabled
                ? 'border border-hairline hover:bg-surface-cream-strong'
                : 'bg-primary text-on-primary'
            }`}
          >
            {provider.enabled ? <PowerOff size={13} /> : <Power size={13} />}
            {provider.enabled ? '停用' : '启用'}
          </button>
        </div>
      </div>

      {!expanded ? null : (
        <>
          <ProviderBasicFields draft={draft} setDraft={setDraft} />
          <div className="mt-5 flex flex-wrap gap-2 border-t border-hairline/70 pt-4">
            <button
              type="button"
              onClick={() => void onSave(provider.id, draft)}
              disabled={busy}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-on-primary disabled:opacity-40"
            >
              <Save size={14} />
              保存配置
            </button>
            <button
              type="button"
              onClick={() => void onDelete(provider.id)}
              disabled={busy}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-error/30 px-4 text-sm text-error hover:bg-error/8 disabled:opacity-40"
            >
              <Trash2 size={14} />
              删除
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ProviderBasicFields({
  draft,
  setDraft,
}: {
  draft: ProviderDraft;
  setDraft: React.Dispatch<React.SetStateAction<ProviderDraft>>;
}) {
  return (
    <div className="mt-4 grid gap-3 sm:grid-cols-2">
      <TextField
        label="显示名称"
        value={draft.display_name}
        onChange={(value) =>
          setDraft((prev) => ({ ...prev, display_name: value }))
        }
      />
      <TextField
        label="模型名"
        value={draft.model_name}
        onChange={(value) =>
          setDraft((prev) => ({ ...prev, model_name: value }))
        }
      />
      <TextField
        label="API Key"
        value={draft.api_key}
        placeholder="明文填写，保存后生效"
        onChange={(value) => setDraft((prev) => ({ ...prev, api_key: value }))}
      />
      <TextAreaField
        label="模型说明"
        value={draft.description}
        placeholder="例如：适合日常聊天、复杂推理或低成本批量任务"
        onChange={(value) =>
          setDraft((prev) => ({ ...prev, description: value }))
        }
      />
      <label className="space-y-1.5">
        <div className="text-[12px] font-medium text-muted">协议类型</div>
        <select
          value={draft.pi_api}
          onChange={(event) =>
            setDraft((prev) => ({
              ...prev,
              pi_api: event.target.value as AdminModelPiApi,
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
      <NumberField
        label="上下文窗口 Token（0 为自动）"
        value={draft.context_window_tokens}
        onChange={(value) =>
          setDraft((prev) => ({
            ...prev,
            context_window_tokens: value,
          }))
        }
      />
      <TextField
        label="Base URL"
        value={draft.base_url}
        placeholder="可选"
        onChange={(value) => setDraft((prev) => ({ ...prev, base_url: value }))}
      />
      <NumberField
        label="输入单价（软妹币 / 百万 Token）"
        value={draft.input_token_price_per_million_coins}
        onChange={(value) =>
          setDraft((prev) => ({
            ...prev,
            input_token_price_per_million_coins: value,
          }))
        }
      />
      <NumberField
        label="输出单价（软妹币 / 百万 Token）"
        value={draft.output_token_price_per_million_coins}
        onChange={(value) =>
          setDraft((prev) => ({
            ...prev,
            output_token_price_per_million_coins: value,
          }))
        }
      />
    </div>
  );
}

export function ProviderCreatePanel({
  draft,
  busy,
  secret,
  onChange,
  onCreate,
  onSecretChange,
}: {
  draft: ProviderDraft;
  busy: boolean;
  secret: string;
  onChange: (draft: ProviderDraft) => void;
  onCreate: () => Promise<void>;
  onSecretChange: (value: string) => void;
}) {
  const canCreate =
    Boolean(draft.display_name.trim()) &&
    Boolean(draft.model_name.trim()) &&
    Boolean(secret.trim());

  return (
    <div className="rounded-lg border border-dashed border-hairline bg-surface-card p-4 sm:p-5">
      <div>
        <div className="text-sm font-semibold">新增官方模型</div>
        <div className="mt-1 text-[13px] text-muted">
          协议类型决定请求格式，例如 Chat Completions、Responses、Anthropic
          Messages 或 Google Generative AI。
        </div>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <TextField
          label="显示名称"
          value={draft.display_name}
          placeholder="例如：Claude Sonnet"
          onChange={(value) => onChange({ ...draft, display_name: value })}
        />
        <TextField
          label="模型名"
          value={draft.model_name}
          placeholder="例如：gpt-4.1"
          onChange={(value) => onChange({ ...draft, model_name: value })}
        />
        <TextField
          label="API Key"
          value={secret}
          placeholder="明文填写，保存后即可使用"
          onChange={onSecretChange}
        />
        <label className="space-y-1.5">
          <div className="text-[12px] font-medium text-muted">协议类型</div>
          <select
            value={draft.pi_api}
            onChange={(event) =>
              onChange({
                ...draft,
                pi_api: event.target.value as AdminModelPiApi,
              })
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
          label="模型说明"
          value={draft.description}
          placeholder="例如：适合高质量问答和复杂推理"
          onChange={(value) => onChange({ ...draft, description: value })}
        />
        <TextField
          label="Base URL"
          value={draft.base_url}
          placeholder="可选"
          onChange={(value) => onChange({ ...draft, base_url: value })}
        />
        <NumberField
          label="上下文窗口 Token（0 为自动）"
          value={draft.context_window_tokens}
          onChange={(value) =>
            onChange({
              ...draft,
              context_window_tokens: value,
            })
          }
        />
        <NumberField
          label="输入单价（软妹币 / 百万 Token）"
          value={draft.input_token_price_per_million_coins}
          onChange={(value) =>
            onChange({
              ...draft,
              input_token_price_per_million_coins: value,
            })
          }
        />
        <NumberField
          label="输出单价（软妹币 / 百万 Token）"
          value={draft.output_token_price_per_million_coins}
          onChange={(value) =>
            onChange({
              ...draft,
              output_token_price_per_million_coins: value,
            })
          }
        />
        <button
          type="button"
          onClick={() => void onCreate()}
          disabled={busy || !canCreate}
          className="inline-flex h-11 items-center justify-center gap-2 self-end rounded-lg bg-primary px-4 text-sm font-medium text-on-primary disabled:opacity-40"
        >
          {busy ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Save size={14} />
          )}
          保存模型
        </button>
      </div>
      <div className="mt-3 flex flex-wrap gap-4 text-[13px] text-muted">
        <label className="inline-flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) =>
              onChange({ ...draft, enabled: event.target.checked })
            }
            className="h-4 w-4 accent-primary"
          />
          启用
        </label>
      </div>
    </div>
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
      <div className="text-[12px] font-medium text-muted">{label}</div>
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={CONTROL}
      />
    </label>
  );
}

function TextAreaField({
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
    <label className="space-y-1.5 sm:col-span-2">
      <div className="text-[12px] font-medium text-muted">{label}</div>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        rows={3}
        maxLength={240}
        className="min-h-24 w-full resize-y rounded-lg border border-hairline bg-canvas px-3 py-2.5 text-sm leading-6 focus:border-hairline focus:outline-none"
      />
      <div className="text-[11px] text-muted">{value.trim().length}/240</div>
    </label>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min = 0,
  max,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <label className="space-y-1.5">
      <div className="text-[12px] font-medium text-muted">{label}</div>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) =>
          onChange(Number.parseInt(event.target.value || '0', 10) || 0)
        }
        className={CONTROL}
      />
    </label>
  );
}
