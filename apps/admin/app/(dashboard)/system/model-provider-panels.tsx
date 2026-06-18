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
  Star,
  Trash2,
} from 'lucide-react';
import {
  PI_API_OPTIONS,
  protocolTypeLabel,
} from '../../../features/model-settings/pi-api-options';
import { OfficialModelPriceTags } from '../../../components/settings/official-model-price-tags';
import {
  customModelPlatformFeeLabel,
  officialModelCoinsLabel,
} from '../../../components/settings/model-pricing';
import { setProviderDraftEnabled, type ProviderDraft } from './provider-draft';

const CONTROL =
  'h-11 w-full rounded-lg border border-hairline bg-canvas px-3 text-sm focus:border-hairline focus:outline-none';
const THINKING_LEVEL_OPTIONS: Array<{
  value: AdminRuntimeConfig['default_thinking_level'];
  label: string;
}> = [
  { value: 'off', label: '关闭' },
  { value: 'minimal', label: '极低' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '极高' },
];

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
  const defaultModelId = overview?.runtime.default_official_model_id;
  const configuredDefault = overview?.providers.find(
    (model) => model.id === defaultModelId && model.enabled && model.has_secret,
  );
  if (configuredDefault) return configuredDefault;
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
  const runtimeProvider = resolveRuntimeProvider(overview);
  const configuredDefault = overview.providers.find(
    (model) => model.id === overview.runtime.default_official_model_id,
  );
  return (
    <div className="rounded-lg border border-hairline bg-surface-card p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="text-sm font-semibold">官方模型池</div>
          <div className="mt-1 text-[12px] leading-5 text-muted">
            用户未选择、选择失效或自配模型不可用时，系统会优先使用后台默认官方模型；默认不可用时回退到价格最低的可用官方模型。
          </div>
          <div className="mt-2 text-[12px] leading-5 text-muted">
            当前默认：
            <span className="font-medium text-ink">
              {runtimeProvider?.display_name ?? '未配置可用默认模型'}
            </span>
            {configuredDefault && !runtimeProvider ? (
              <span className="ml-2 text-error">已配置但不可用</span>
            ) : null}
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
  providers,
  busy,
  onSave,
}: {
  runtime: AdminRuntimeConfig;
  providers: AdminModelProvider[];
  busy: boolean;
  onSave: (config: {
    agent_concurrency_limit: number;
    local_agent_max_processes: number;
    local_agent_idle_ttl_ms: number;
    default_official_model_id: string | null;
    default_thinking_level: AdminRuntimeConfig['default_thinking_level'];
    pi_session_health_enabled: boolean;
    pi_session_inactive_cleanup_days: number;
    pi_session_orphan_grace_days: number;
    user_skill_max_count: number;
    skill_bundle_max_files: number;
    skill_bundle_max_file_chars: number;
    skill_bundle_max_total_chars: number;
    skill_bundle_max_zip_bytes: number;
  }) => Promise<void>;
}) {
  const [limit, setLimit] = useState(runtime.agent_concurrency_limit);
  const [maxProcesses, setMaxProcesses] = useState(
    runtime.local_agent_max_processes,
  );
  const [idleSeconds, setIdleSeconds] = useState(
    Math.round(runtime.local_agent_idle_ttl_ms / 1000),
  );
  const [defaultOfficialModelId, setDefaultOfficialModelId] = useState(
    runtime.default_official_model_id ?? '',
  );
  const [defaultThinkingLevel, setDefaultThinkingLevel] = useState(
    runtime.default_thinking_level,
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
  const [userSkillMaxCount, setUserSkillMaxCount] = useState(
    runtime.user_skill_max_count,
  );
  const [skillMaxFiles, setSkillMaxFiles] = useState(
    runtime.skill_bundle_max_files,
  );
  const [skillMaxFileChars, setSkillMaxFileChars] = useState(
    runtime.skill_bundle_max_file_chars,
  );
  const [skillMaxTotalChars, setSkillMaxTotalChars] = useState(
    runtime.skill_bundle_max_total_chars,
  );
  const [skillMaxZipMb, setSkillMaxZipMb] = useState(
    Math.round(runtime.skill_bundle_max_zip_bytes / 1024 / 1024),
  );

  useEffect(() => {
    setLimit(runtime.agent_concurrency_limit);
    setMaxProcesses(runtime.local_agent_max_processes);
    setIdleSeconds(Math.round(runtime.local_agent_idle_ttl_ms / 1000));
    setDefaultOfficialModelId(runtime.default_official_model_id ?? '');
    setDefaultThinkingLevel(runtime.default_thinking_level);
    setPiHealthEnabled(runtime.pi_session_health_enabled);
    setPiInactiveDays(runtime.pi_session_inactive_cleanup_days);
    setPiOrphanGraceDays(runtime.pi_session_orphan_grace_days);
    setUserSkillMaxCount(runtime.user_skill_max_count);
    setSkillMaxFiles(runtime.skill_bundle_max_files);
    setSkillMaxFileChars(runtime.skill_bundle_max_file_chars);
    setSkillMaxTotalChars(runtime.skill_bundle_max_total_chars);
    setSkillMaxZipMb(
      Math.round(runtime.skill_bundle_max_zip_bytes / 1024 / 1024),
    );
  }, [
    runtime.agent_concurrency_limit,
    runtime.default_official_model_id,
    runtime.default_thinking_level,
    runtime.local_agent_idle_ttl_ms,
    runtime.local_agent_max_processes,
    runtime.pi_session_health_enabled,
    runtime.pi_session_inactive_cleanup_days,
    runtime.pi_session_orphan_grace_days,
    runtime.user_skill_max_count,
    runtime.skill_bundle_max_file_chars,
    runtime.skill_bundle_max_files,
    runtime.skill_bundle_max_total_chars,
    runtime.skill_bundle_max_zip_bytes,
  ]);

  const normalizedSkillMaxFileChars = Math.min(
    2_000_000,
    Math.max(1, Math.floor(skillMaxFileChars)),
  );
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
    default_official_model_id: defaultOfficialModelId || null,
    default_thinking_level: defaultThinkingLevel,
    pi_session_health_enabled: piHealthEnabled,
    pi_session_inactive_cleanup_days: Math.min(
      3650,
      Math.max(1, Math.floor(piInactiveDays)),
    ),
    pi_session_orphan_grace_days: Math.min(
      3650,
      Math.max(1, Math.floor(piOrphanGraceDays)),
    ),
    user_skill_max_count: Math.min(
      500,
      Math.max(1, Math.floor(userSkillMaxCount)),
    ),
    skill_bundle_max_files: Math.min(
      500,
      Math.max(1, Math.floor(skillMaxFiles)),
    ),
    skill_bundle_max_file_chars: normalizedSkillMaxFileChars,
    skill_bundle_max_total_chars: Math.min(
      10_000_000,
      Math.max(normalizedSkillMaxFileChars, Math.floor(skillMaxTotalChars)),
    ),
    skill_bundle_max_zip_bytes:
      Math.min(100, Math.max(1, Math.floor(skillMaxZipMb))) * 1024 * 1024,
  };
  const dirty =
    normalized.agent_concurrency_limit !== runtime.agent_concurrency_limit ||
    normalized.local_agent_max_processes !==
      runtime.local_agent_max_processes ||
    normalized.local_agent_idle_ttl_ms !== runtime.local_agent_idle_ttl_ms ||
    normalized.default_official_model_id !==
      (runtime.default_official_model_id ?? null) ||
    normalized.default_thinking_level !== runtime.default_thinking_level ||
    normalized.pi_session_health_enabled !==
      runtime.pi_session_health_enabled ||
    normalized.pi_session_inactive_cleanup_days !==
      runtime.pi_session_inactive_cleanup_days ||
    normalized.pi_session_orphan_grace_days !==
      runtime.pi_session_orphan_grace_days ||
    normalized.user_skill_max_count !== runtime.user_skill_max_count ||
    normalized.skill_bundle_max_files !== runtime.skill_bundle_max_files ||
    normalized.skill_bundle_max_file_chars !==
      runtime.skill_bundle_max_file_chars ||
    normalized.skill_bundle_max_total_chars !==
      runtime.skill_bundle_max_total_chars ||
    normalized.skill_bundle_max_zip_bytes !==
      runtime.skill_bundle_max_zip_bytes;

  return (
    <div className="rounded-lg border border-hairline bg-surface-card p-4 sm:p-5">
      <div className="grid gap-5 xl:grid-cols-[minmax(220px,0.75fr)_minmax(0,1.25fr)]">
        <div className="min-w-0">
          <div className="text-sm font-semibold">Agent 运行时策略</div>
          <div className="mt-1 text-[12px] leading-5 text-muted">
            控制请求并发、常驻 agent-runtime、空闲回收和 Pi session
            自动健康维护。
          </div>
          <div className="mt-3 grid gap-1 text-[12px] text-muted">
            <div>
              当前 Agent：{runtime.agent_concurrency_limit} 并发 /{' '}
              {runtime.local_agent_max_processes} runtime /{' '}
              {Math.round(runtime.local_agent_idle_ttl_ms / 1000)} 秒回收
            </div>
            <div>
              当前 Pi：
              {runtime.pi_session_health_enabled ? '自动维护' : '手动维护'} /{' '}
              {runtime.pi_session_inactive_cleanup_days} 天未活跃 /{' '}
              {runtime.pi_session_orphan_grace_days} 天孤儿保护
            </div>
            <div>
              当前 Skill：每人 {runtime.user_skill_max_count} 个 /{' '}
              {runtime.skill_bundle_max_files} 文件 / 单文件{' '}
              {runtime.skill_bundle_max_file_chars.toLocaleString()} 字 / 总计{' '}
              {runtime.skill_bundle_max_total_chars.toLocaleString()} 字
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <div className="mb-2 text-[12px] font-medium text-muted">
              Agent 资源
            </div>
            <div className="grid gap-2 md:grid-cols-3">
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
            </div>
          </div>

          <div className="grid gap-3 border-t border-hairline/70 pt-4 md:grid-cols-2">
            <label className="block space-y-1.5">
              <div className="text-[12px] font-medium text-muted">
                默认官方模型
              </div>
              <select
                value={defaultOfficialModelId}
                onChange={(event) =>
                  setDefaultOfficialModelId(event.target.value)
                }
                className={CONTROL}
              >
                <option value="">未指定，使用最低价兜底</option>
                {providers.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.display_name}
                    {model.enabled && model.has_secret ? '' : '（不可用）'}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1.5">
              <div className="text-[12px] font-medium text-muted">
                默认思考等级
              </div>
              <select
                value={defaultThinkingLevel}
                onChange={(event) =>
                  setDefaultThinkingLevel(
                    event.target
                      .value as AdminRuntimeConfig['default_thinking_level'],
                  )
                }
                className={CONTROL}
              >
                {THINKING_LEVEL_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="border-t border-hairline/70 pt-4">
            <div className="mb-2 text-[12px] font-medium text-muted">
              Pi session 健康
            </div>
            <div className="grid gap-2 md:grid-cols-3">
              <label className="flex h-11 items-center gap-2 rounded-lg border border-hairline bg-canvas px-3 text-[12px] text-muted">
                <input
                  type="checkbox"
                  checked={piHealthEnabled}
                  onChange={(event) => setPiHealthEnabled(event.target.checked)}
                  className="h-4 w-4 accent-primary"
                />
                自动维护
              </label>
              <NumberField
                label="未活跃天数"
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
            </div>
          </div>

          <div className="border-t border-hairline/70 pt-4">
            <div className="mb-2 text-[12px] font-medium text-muted">
              Skill Bundle 限制
            </div>
            <div className="grid gap-2 md:grid-cols-5">
              <NumberField
                label="每人 Skill 数"
                value={userSkillMaxCount}
                onChange={setUserSkillMaxCount}
                min={1}
                max={500}
              />
              <NumberField
                label="文本文件数"
                value={skillMaxFiles}
                onChange={setSkillMaxFiles}
                min={1}
                max={500}
              />
              <NumberField
                label="单文件字符"
                value={skillMaxFileChars}
                onChange={setSkillMaxFileChars}
                min={1}
                max={2_000_000}
              />
              <NumberField
                label="总字符"
                value={skillMaxTotalChars}
                onChange={setSkillMaxTotalChars}
                min={1}
                max={10_000_000}
              />
              <NumberField
                label="ZIP 体积 MB"
                value={skillMaxZipMb}
                onChange={setSkillMaxZipMb}
                min={1}
                max={100}
              />
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void onSave(normalized)}
              disabled={busy || !dirty}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-on-primary disabled:opacity-40"
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
  isActive,
  onSave,
  onSetDefault,
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
  const canSetDefault = provider.enabled && provider.has_secret;

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
            {isActive && (
              <span className="inline-flex whitespace-nowrap rounded-full bg-primary/10 px-2 py-1 text-[10px] text-primary">
                默认
              </span>
            )}
            {!provider.enabled && (
              <span className="whitespace-nowrap rounded-full bg-canvas px-2 py-1 text-[10px] text-muted">
                停用
              </span>
            )}
            {!provider.has_secret && (
              <span className="whitespace-nowrap rounded-full bg-canvas px-2 py-1 text-[10px] text-muted">
                缺少密钥
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => void onSetDefault(provider.id)}
            disabled={busy || isActive || !canSetDefault}
            className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg border border-hairline px-3 text-[12px] font-medium hover:bg-surface-cream-strong disabled:opacity-40"
          >
            <Star size={13} />
            设为默认
          </button>
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
