'use client';

import { useEffect, useState } from 'react';
import type {
  AdminModelProvider,
  AdminModelPiApi,
  AdminSystemConfigOverview,
} from '@/lib/admin-api';
import {
  ChevronDown,
  ChevronUp,
  KeyRound,
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
import {
  setProviderDraftEnabled,
  type ProviderDraft,
} from './provider-draft';

const CONTROL =
  'h-11 w-full rounded-lg border border-hairline bg-canvas px-3 text-sm focus:border-hairline focus:outline-none';

function providerDraftFrom(model: AdminModelProvider): ProviderDraft {
  return {
    model_key: model.model_key,
    pi_api: model.pi_api,
    display_name: model.display_name,
    enabled: model.enabled,
    priority: model.priority,
    base_url: model.base_url || '',
    model_name: model.model_name,
    context_window_tokens: model.context_window_tokens ?? 0,
    input_token_price_per_million_points:
      model.input_token_price_per_million_points,
    output_token_price_per_million_points:
      model.output_token_price_per_million_points,
  };
}

function getSecretSourceLabel(
  source: AdminModelProvider['secret_source'],
): string {
  return source === 'database' ? '已保存密钥' : '未配置密钥';
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
            用户必须显式选择某个可用官方模型；系统不会自动回退。
          </div>
        </div>
        <div className="rounded-full bg-canvas px-2.5 py-1 text-[11px] text-muted">
          {availableCount} 个可选模型
        </div>
      </div>
    </div>
  );
}

export function ProviderRow({
  provider,
  busy,
  onSave,
  onSaveSecret,
  onDelete,
}: {
  provider: AdminModelProvider;
  busy: boolean;
  isActive: boolean;
  onSave: (id: string, draft: ProviderDraft) => Promise<void>;
  onSaveSecret: (
    id: string,
    secret: string,
  ) => Promise<void>;
  onSetDefault: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<ProviderDraft>(() =>
    providerDraftFrom(provider),
  );
  const [secret, setSecret] = useState('');
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setDraft(providerDraftFrom(provider));
  }, [provider]);

  const sourceLabel = getSecretSourceLabel(provider.secret_source);
  const toggledDraft = setProviderDraftEnabled(draft, !provider.enabled);

  return (
    <div className="rounded-lg border border-hairline bg-surface-card p-4 sm:p-5">
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_220px] xl:items-start">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex min-w-0 cursor-pointer items-start gap-3 text-left"
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-col gap-3 xl:grid xl:grid-cols-[minmax(160px,1.2fr)_minmax(140px,0.8fr)_minmax(140px,1fr)_minmax(96px,0.75fr)] xl:items-center xl:gap-3">
              <div className="min-w-0">
                <div className="truncate text-[14px] font-semibold">
                  {provider.display_name}
                </div>
              </div>
              <div className="text-[12px] text-muted">
                {protocolTypeLabel(provider.pi_api)}
              </div>
              <div className="truncate text-[12px] font-medium">
                {provider.model_name || '未配置'}
              </div>
              <div className="truncate text-[12px] text-muted">
                {provider.base_url || '默认'}
              </div>
            </div>
          </div>
          {expanded ? (
            <ChevronUp
              size={16}
              className="mt-1 shrink-0 text-muted"
            />
          ) : (
            <ChevronDown
              size={16}
              className="mt-1 shrink-0 text-muted"
            />
          )}
        </button>

        <div className="flex min-w-0 flex-col gap-2 xl:items-end">
          <div className="flex min-w-0 flex-wrap gap-1.5 xl:justify-end">
            {!provider.enabled && (
              <span className="whitespace-nowrap rounded-full bg-canvas px-2 py-1 text-[10px] text-muted">
                停用
              </span>
            )}
            <span className="whitespace-nowrap rounded-full bg-canvas px-2 py-1 text-[10px] text-muted">
              {sourceLabel}
            </span>
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
          <ProviderSecretFields
            busy={busy}
            onSaveSecret={async () => {
              await onSaveSecret(provider.id, secret);
              setSecret('');
            }}
            secret={secret}
            setSecret={setSecret}
            sourceLabel={sourceLabel}
          />
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
      <label className="space-y-1.5">
        <div className="text-[12px] font-medium text-muted">
          协议类型
        </div>
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
      <TextField
        label="Base URL"
        value={draft.base_url}
        placeholder="可选"
        onChange={(value) => setDraft((prev) => ({ ...prev, base_url: value }))}
      />
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
      <NumberField
        label="输入单价（积分 / 百万 Token）"
        value={draft.input_token_price_per_million_points}
        onChange={(value) =>
          setDraft((prev) => ({
            ...prev,
            input_token_price_per_million_points: value,
          }))
        }
      />
      <NumberField
        label="输出单价（积分 / 百万 Token）"
        value={draft.output_token_price_per_million_points}
        onChange={(value) =>
          setDraft((prev) => ({
            ...prev,
            output_token_price_per_million_points: value,
          }))
        }
      />
    </div>
  );
}

function ProviderSecretFields({
  busy,
  onSaveSecret,
  secret,
  setSecret,
  sourceLabel,
}: {
  busy: boolean;
  onSaveSecret: () => Promise<void>;
  secret: string;
  setSecret: (value: string) => void;
  sourceLabel: string;
}) {
  return (
    <div className="mt-4 rounded-lg border border-hairline bg-canvas/60 p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <KeyRound size={15} className="text-muted" />
          更新密钥
        </div>
        <div className="text-[12px] text-muted">
          当前状态：{sourceLabel}
        </div>
      </div>
      <div className="mt-3 grid gap-2 lg:grid-cols-[1fr_auto]">
        <input
          type="password"
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
          placeholder="输入新的 API Key"
          className={CONTROL}
        />
        <button
          onClick={() => void onSaveSecret()}
          disabled={busy || !secret}
          className="inline-flex h-11 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-on-primary disabled:opacity-40"
        >
          保存密钥
        </button>
      </div>
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
          协议类型决定请求格式，例如 Chat Completions、Responses、Anthropic Messages 或 Google Generative AI。
        </div>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <TextField
          label="显示名称"
          value={draft.display_name}
          placeholder="例如：Claude Sonnet"
          onChange={(value) => onChange({ ...draft, display_name: value })}
        />
        <label className="space-y-1.5">
          <div className="text-[12px] font-medium text-muted">
            协议类型
          </div>
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
          label="模型名"
          value={draft.model_name}
          placeholder="例如：gpt-4.1"
          onChange={(value) => onChange({ ...draft, model_name: value })}
        />
        <TextField
          label="Base URL"
          value={draft.base_url}
          placeholder="可选"
          onChange={(value) => onChange({ ...draft, base_url: value })}
        />
        <TextField
          label="API Key"
          value={secret}
          placeholder="创建时一并保存"
          type="password"
          onChange={onSecretChange}
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
          label="输入单价"
          value={draft.input_token_price_per_million_points}
          onChange={(value) =>
            onChange({
              ...draft,
              input_token_price_per_million_points: value,
            })
          }
        />
        <NumberField
          label="输出单价"
          value={draft.output_token_price_per_million_points}
          onChange={(value) =>
            onChange({
              ...draft,
              output_token_price_per_million_points: value,
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
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="space-y-1.5">
      <div className="text-[12px] font-medium text-muted">
        {label}
      </div>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={CONTROL}
      />
    </label>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="space-y-1.5">
      <div className="text-[12px] font-medium text-muted">
        {label}
      </div>
      <input
        type="number"
        min={0}
        value={value}
        onChange={(event) =>
          onChange(Number.parseInt(event.target.value || '0', 10) || 0)
        }
        className={CONTROL}
      />
    </label>
  );
}
