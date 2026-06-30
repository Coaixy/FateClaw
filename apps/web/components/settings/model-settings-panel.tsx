'use client';

import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import {
  Brain,
  ChevronDown,
  Check,
  Cpu,
  Hash,
  KeyRound,
  Link2,
  Loader2,
  RefreshCw,
  Save,
  ServerCog,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import Link from 'next/link';

import {
  modelSettingsApi,
  type ModelThinkingLevel,
  type ModelPiApi,
  type ModelSettingsOverview,
  type OfficialModel,
  type UserModelSelection,
} from '@/features/model-settings/api';
import { PI_API_OPTIONS } from '../../features/model-settings/pi-api-options';
import { OfficialModelPriceTags } from './official-model-price-tags';
import { findLowestPricedOfficialModel } from './model-pricing';
import { useI18n } from '@/lib/i18n';

const CONTROL =
  'h-11 w-full rounded-md border border-hairline/80 bg-canvas/70 text-[15px] text-ink outline-none transition-all duration-150 placeholder:text-muted-soft/75 hover:border-primary/30 hover:bg-canvas focus:border-primary/60 focus:bg-canvas focus:shadow-[0_0_0_3px_rgba(204,120,92,0.13)] disabled:cursor-not-allowed disabled:opacity-50';
const ICON_INPUT_CONTROL = `${CONTROL} pl-10 pr-3`;

const DEFAULT_THINKING_LEVEL: ModelThinkingLevel = 'medium';
const THINKING_LEVEL_OPTIONS: Array<{
  value: ModelThinkingLevel;
}> = [
  { value: 'off' },
  { value: 'minimal' },
  { value: 'low' },
  { value: 'medium' },
  { value: 'high' },
  { value: 'xhigh' },
];

function thinkingLevelLabel(value: ModelThinkingLevel, t: TranslationFn) {
  return t(`aiChat.thinkingLevels.${value}`);
}

type TranslationFn = (
  key: string,
  params?: Record<string, string | number>,
) => string;

function resolveSelectionThinkingLevel(
  data: Pick<ModelSettingsOverview, 'selection' | 'default_thinking_level'> | null,
): ModelThinkingLevel {
  return (
    data?.selection?.thinking_level ??
    data?.default_thinking_level ??
    DEFAULT_THINKING_LEVEL
  );
}

function resolveThinkingLevelIndex(value: ModelThinkingLevel): number {
  const index = THINKING_LEVEL_OPTIONS.findIndex(
    (option) => option.value === value,
  );
  return index >= 0 ? index : 3;
}

function resolveThinkingLevelDraftIndex(position: number): number {
  return Math.min(
    THINKING_LEVEL_OPTIONS.length - 1,
    Math.max(0, Math.round(position)),
  );
}

type CustomDraft = {
  pi_api: ModelPiApi;
  base_url: string;
  model_name: string;
  api_key: string;
  context_window_tokens: number;
};

function customDraftFromOverview(data: ModelSettingsOverview): CustomDraft {
  return {
    pi_api: data.custom?.pi_api ?? 'openai-completions',
    base_url: data.custom?.base_url ?? '',
    model_name: data.custom?.model_name ?? '',
    api_key: data.custom?.api_key ?? '',
    context_window_tokens: data.custom?.context_window_tokens ?? 0,
  };
}

function hasUsableCustomModel(data: ModelSettingsOverview): boolean {
  return Boolean(
    (!data.custom_model_membership_required ||
      data.custom_model_membership_entitled) &&
      data.custom?.model_name.trim() &&
      data.custom.has_secret,
  );
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
  const configuredDefaultModel = data.official_models.find(
    (model) =>
      model.id === data.default_official_model_id &&
      model.enabled &&
      model.has_secret,
  );
  const defaultOfficialModel =
    configuredDefaultModel ??
    findLowestPricedOfficialModel(data.official_models);
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
    thinking_level: resolveSelectionThinkingLevel(data),
    created_at: data.selection?.created_at ?? '',
    updated_at: data.selection?.updated_at ?? '',
  };
}

/** 概览资源状态：已加载的概览数据与初始加载标志。 */
type OverviewState = {
  data: ModelSettingsOverview | null;
  loading: boolean;
};

type OverviewAction =
  | { type: 'loadStart' }
  | { type: 'loaded'; data: ModelSettingsOverview }
  | { type: 'loadStop' }
  | { type: 'patchThinkingLevel'; level: ModelThinkingLevel };

/**
 * 概览 reducer。
 * loadStop 单独复位 loading，保持与原逻辑「loading 仅在 finally 置 false」一致；
 * patchThinkingLevel 对应思考档位保存时的乐观更新与失败回滚，仅在已有 selection 时改写。
 */
function overviewReducer(
  state: OverviewState,
  action: OverviewAction,
): OverviewState {
  switch (action.type) {
    case 'loadStart':
      return { ...state, loading: true };
    case 'loaded':
      return { ...state, data: action.data };
    case 'loadStop':
      return { ...state, loading: false };
    case 'patchThinkingLevel':
      return state.data?.selection
        ? {
            ...state,
            data: {
              ...state.data,
              selection: {
                ...state.data.selection,
                thinking_level: action.level,
              },
            },
          }
        : state;
    default:
      return state;
  }
}

const OVERVIEW_INITIAL: OverviewState = { data: null, loading: true };

export function ModelSettingsPanel() {
  const { t } = useI18n();
  // 概览数据与加载态合并为一个 reducer；保留 overview/loading 读名不变。
  const [{ data: overview, loading }, overviewDispatch] = useReducer(
    overviewReducer,
    OVERVIEW_INITIAL,
  );
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const thinkingSaveVersion = useRef(0);
  const [custom, setCustom] = useState<CustomDraft>({
    pi_api: 'openai-completions',
    base_url: '',
    model_name: '',
    api_key: '',
    context_window_tokens: 0,
  });

  const load = useCallback(async () => {
    overviewDispatch({ type: 'loadStart' });
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
        defaultSelectionMessage = t('pages.modelSettings.defaultOfficialMessage', {
          model: defaultOfficialModel.display_name,
        });
      }
      overviewDispatch({ type: 'loaded', data: nextOverview });
      setCustom(customDraftFromOverview(nextOverview));
      if (defaultSelectionMessage) {
        setMessage(defaultSelectionMessage);
      }
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : t('pages.modelSettings.loadFailed'),
      );
    } finally {
      overviewDispatch({ type: 'loadStop' });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveCustom = async () => {
    setBusy('custom');
    setMessage('');
    try {
      await modelSettingsApi.saveCustom({
        pi_api: custom.pi_api,
        base_url: custom.base_url.trim() || null,
        model_name: custom.model_name.trim(),
        context_window_tokens: custom.context_window_tokens || null,
        api_key: custom.api_key.trim(),
      });
      setMessage(t('pages.modelSettings.customSaved'));
      await load();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : t('pages.modelSettings.saveFailed'),
      );
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
        thinking_level: resolveSelectionThinkingLevel(
          overview,
        ),
      });
      setMessage(t('pages.modelSettings.officialSelected'));
      await load();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : t('pages.modelSettings.selectFailed'),
      );
    } finally {
      setBusy('');
    }
  };

  const selectCustom = async () => {
    setBusy('select-custom');
    setMessage('');
    try {
      await modelSettingsApi.select({
        source: 'custom',
        thinking_level: resolveSelectionThinkingLevel(
          overview,
        ),
      });
      setMessage(t('pages.modelSettings.customSelected'));
      await load();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : t('pages.modelSettings.selectFailed'),
      );
    } finally {
      setBusy('');
    }
  };

  const saveThinkingLevel = async (thinkingLevel: ModelThinkingLevel) => {
    const selection = overview?.selection;
    if (!selection) return;
    const previousThinkingLevel = resolveSelectionThinkingLevel(overview);
    const saveVersion = thinkingSaveVersion.current + 1;
    thinkingSaveVersion.current = saveVersion;
    // 乐观更新：先把档位改到目标值，失败再回滚。
    overviewDispatch({ type: 'patchThinkingLevel', level: thinkingLevel });
    try {
      await modelSettingsApi.select({
        source: selection.source,
        official_model_id: selection.official_model_id,
        thinking_level: thinkingLevel,
      });
    } catch (error) {
      if (thinkingSaveVersion.current === saveVersion) {
        // 仅当没有更新的保存覆盖时才回滚到先前档位。
        overviewDispatch({
          type: 'patchThinkingLevel',
          level: previousThinkingLevel,
        });
      }
      setMessage(
        error instanceof Error ? error.message : t('pages.modelSettings.saveFailed'),
      );
    }
  };

  if (loading) {
    return (
      <div className="rounded-lg border border-hairline bg-surface-card px-4 py-8 text-center text-[13px] text-muted">
        {t('pages.modelSettings.loading')}
      </div>
    );
  }

  const selection = overview?.selection;
  const officialModels = overview?.official_models ?? [];
  const customModelMembershipRequired =
    overview?.custom_model_membership_required ?? true;
  const customModelMembershipEntitled =
    overview?.custom_model_membership_entitled ?? false;
  const customModelAccessLabel = customModelMembershipRequired
    ? customModelMembershipEntitled
      ? t('pages.modelSettings.customMemberActive')
      : t('pages.modelSettings.customMemberOnly')
    : t('pages.modelSettings.customIncluded');
  const selectedSourceLabel =
    selection?.source === 'custom'
      ? t('pages.modelSettings.customSource')
      : selection?.source === 'official'
        ? t('pages.modelSettings.officialSource')
        : t('pages.modelSettings.noSelection');
  const selectedModelLabel =
    selection?.source === 'custom'
      ? custom.model_name.trim() || t('pages.modelSettings.customModel')
      : officialModels.find(
          (model) => model.id === selection?.official_model_id,
        )?.display_name ?? t('pages.modelSettings.noModel');
  const availableOfficialModels = officialModels.filter(
    (model) => model.enabled && model.has_secret,
  ).length;
  const thinkingLevel = resolveSelectionThinkingLevel(overview);

  return (
    <div className="space-y-5">
      <section className="overflow-hidden rounded-lg border border-hairline bg-surface-card">
        <div className="grid lg:grid-cols-[minmax(0,1.25fr)_360px]">
          <div className="p-4 sm:p-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[12px] font-semibold text-muted">
                  <Check size={13} className="text-primary" />
                  {t('pages.modelSettings.currentModel')}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="text-[22px] font-semibold leading-tight text-ink">
                    {selectedModelLabel}
                  </span>
                  <span className="rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                    {selectedSourceLabel}
                  </span>
                </div>
                <div className="mt-2 max-w-2xl text-[12px] leading-5 text-muted">
                  {t('pages.modelSettings.fallbackDescription')}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void load()}
                className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg border border-hairline px-3 text-[12px] text-muted transition-colors hover:bg-surface-cream-strong hover:text-ink"
              >
                <RefreshCw size={13} />
                {t('pages.modelSettings.refresh')}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 border-t border-hairline bg-canvas/45 lg:border-l lg:border-t-0">
            <SummaryTile
              label={t('pages.modelSettings.summarySource')}
              value={selectedSourceLabel}
            />
            <SummaryTile
              label={t('pages.modelSettings.summaryOfficialAvailable')}
              value={`${availableOfficialModels}/${officialModels.length}`}
            />
            <SummaryTile
              label={t('pages.modelSettings.summaryProtocol')}
              value={custom.pi_api || t('pages.modelSettings.unconfigured')}
            />
            <SummaryTile
              label={t('pages.modelSettings.summaryCustomAccess')}
              value={customModelAccessLabel}
            />
            <SummaryTile
              label={t('pages.modelSettings.summaryThinking')}
              value={thinkingLevelLabel(thinkingLevel, t)}
            />
          </div>
        </div>
      </section>

      {message && (
        <div className="rounded-lg border border-primary/20 bg-primary/8 px-3 py-2 text-[12px] text-primary">
          {message}
        </div>
      )}

      <ThinkingLevelSection
        value={thinkingLevel}
        onChange={saveThinkingLevel}
        t={t}
      />

      <OfficialModelsSection
        busy={busy}
        models={officialModels}
        selection={selection ?? null}
        t={t}
        onSelectOfficial={selectOfficial}
      />

      <CustomModelSection
        busy={busy}
        custom={custom}
        membershipEntitled={customModelMembershipEntitled}
        membershipRequired={customModelMembershipRequired}
        selected={selection?.source === 'custom'}
        setCustom={setCustom}
        t={t}
        onSaveCustom={saveCustom}
        onSelectCustom={selectCustom}
      />
    </div>
  );
}

function ThinkingLevelSection({
  value,
  onChange,
  t,
}: {
  value: ModelThinkingLevel;
  onChange: (value: ModelThinkingLevel) => Promise<void>;
  t: TranslationFn;
}) {
  const [draftPosition, setDraftPosition] = useState(() =>
    resolveThinkingLevelIndex(value),
  );

  useEffect(() => {
    setDraftPosition(resolveThinkingLevelIndex(value));
  }, [value]);

  const draftIndex = resolveThinkingLevelDraftIndex(draftPosition);
  const draftOption =
    THINKING_LEVEL_OPTIONS[draftIndex] ??
    THINKING_LEVEL_OPTIONS[resolveThinkingLevelIndex(DEFAULT_THINKING_LEVEL)];
  const draftLabel = thinkingLevelLabel(draftOption.value, t);
  const rangeMax = THINKING_LEVEL_OPTIONS.length - 1;
  const progressPercent = rangeMax > 0 ? (draftPosition / rangeMax) * 100 : 0;

  const commitPosition = (position: number) => {
    const nextIndex = resolveThinkingLevelDraftIndex(position);
    const nextValue =
      THINKING_LEVEL_OPTIONS[nextIndex]?.value ?? DEFAULT_THINKING_LEVEL;
    setDraftPosition(nextIndex);
    if (nextValue === value) return;
    void onChange(nextValue);
  };

  const stepKeyboard = (nextIndex: number) => {
    const normalizedIndex = Math.min(rangeMax, Math.max(0, nextIndex));
    setDraftPosition(normalizedIndex);
    commitPosition(normalizedIndex);
  };

  return (
    <section className="rounded-lg border border-hairline bg-surface-card p-4 sm:p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-hairline bg-canvas text-primary">
            <Brain size={16} />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-sm font-semibold text-ink">
                {t('pages.modelSettings.thinkingTitle')}
              </div>
              <span className="rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                {draftLabel}
              </span>
            </div>
            <div className="mt-1 text-[12px] leading-5 text-muted">
              {t('pages.modelSettings.thinkingDescription')}
            </div>
          </div>
        </div>
        <div className="w-full sm:w-[360px]">
          <div className="flex items-center gap-2">
            <div className="relative h-7 flex-1">
              <div className="absolute left-0 right-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-hairline/80" />
              <div
                className="absolute left-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-primary transition-[width] duration-150"
                style={{ width: `${progressPercent}%` }}
              />
              <input
                type="range"
                min={0}
                max={rangeMax}
                step={0.01}
                value={draftPosition}
                aria-label={t('pages.modelSettings.thinkingAria')}
                aria-valuetext={draftLabel}
                onChange={(event) =>
                  setDraftPosition(Number.parseFloat(event.target.value))
                }
                onPointerUp={(event) =>
                  commitPosition(Number.parseFloat(event.currentTarget.value))
                }
                onBlur={(event) =>
                  commitPosition(Number.parseFloat(event.currentTarget.value))
                }
                onKeyDown={(event) => {
                  if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
                    event.preventDefault();
                    stepKeyboard(draftIndex - 1);
                  } else if (
                    event.key === 'ArrowRight' ||
                    event.key === 'ArrowUp'
                  ) {
                    event.preventDefault();
                    stepKeyboard(draftIndex + 1);
                  } else if (event.key === 'Home') {
                    event.preventDefault();
                    stepKeyboard(0);
                  } else if (event.key === 'End') {
                    event.preventDefault();
                    stepKeyboard(rangeMax);
                  }
                }}
                className="absolute inset-0 z-10 h-7 w-full cursor-pointer appearance-none bg-transparent [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-surface-card [&::-moz-range-thumb]:bg-primary [&::-moz-range-thumb]:shadow-sm [&::-moz-range-track]:bg-transparent [&::-webkit-slider-runnable-track]:h-7 [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:mt-1.5 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-surface-card [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:shadow-sm"
              />
            </div>
          </div>
          <div className="mt-3 grid grid-cols-6 gap-1 text-center">
            {THINKING_LEVEL_OPTIONS.map((option, index) => (
              <span
                key={option.value}
                className={`truncate text-[10px] font-medium ${
                  index === draftIndex ? 'text-primary' : 'text-muted'
                }`}
              >
                {thinkingLevelLabel(option.value, t)}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function SummaryTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 border-b border-r border-hairline/60 px-4 py-3 last:border-b-0 even:border-r-0 lg:[&:nth-last-child(-n+2)]:border-b-0">
      <div className="text-[10px] font-medium text-muted">
        {label}
      </div>
      <div className="mt-1 truncate text-[13px] font-semibold text-ink">
        {value}
      </div>
    </div>
  );
}

function CustomModelSection({
  busy,
  custom,
  membershipEntitled,
  membershipRequired,
  selected,
  setCustom,
  t,
  onSaveCustom,
  onSelectCustom,
}: {
  busy: string;
  custom: CustomDraft;
  membershipEntitled: boolean;
  membershipRequired: boolean;
  selected: boolean;
  setCustom: Dispatch<SetStateAction<CustomDraft>>;
  t: TranslationFn;
  onSaveCustom: () => Promise<void>;
  onSelectCustom: () => Promise<void>;
}) {
  const membershipBlocked = membershipRequired && !membershipEntitled;
  const membershipBadge = membershipRequired
    ? membershipEntitled
      ? t('pages.modelSettings.customMemberActive')
      : t('pages.modelSettings.customMemberOnly')
    : t('pages.modelSettings.customIncluded');

  return (
    <section
      className={`overflow-hidden rounded-lg border ${
        selected
          ? 'border-primary/40 bg-primary/8'
          : 'border-hairline bg-surface-card'
      }`}
    >
      <div className="flex flex-col gap-3 border-b border-hairline/70 p-4 sm:flex-row sm:items-start sm:justify-between sm:p-5">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-hairline bg-canvas text-primary">
            <ServerCog size={16} />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
              {t('pages.modelSettings.customTitle')}
              {selected && (
                <span className="inline-flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[10px] font-medium text-on-primary">
                  <Check size={11} />
                  {t('pages.modelSettings.current')}
                </span>
              )}
            </div>
            <div className="mt-1 text-[12px] leading-5 text-muted">
              {t('pages.modelSettings.customDescription')}
            </div>
          </div>
        </div>
        <span className="inline-flex shrink-0 items-center rounded-full bg-primary/10 px-2.5 py-1 text-[10px] font-medium text-primary">
          {membershipBadge}
        </span>
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="p-4 sm:p-5">
          <div className="mb-4 text-[12px] leading-5 text-muted">
            {t('pages.modelSettings.customBillingDescription')}
          </div>
          <CustomModelFields
            custom={custom}
            setCustom={setCustom}
            t={t}
          />
          <div className="mt-4 grid gap-2 lg:grid-cols-[minmax(0,1fr)_160px] lg:items-end">
            <FormField
              label="API Key"
              icon={<KeyRound size={15} />}
            >
              <input
                type="text"
                value={custom.api_key}
                onChange={(event) =>
                  setCustom((prev) => ({
                    ...prev,
                    api_key: event.target.value,
                  }))
                }
                placeholder={t('pages.modelSettings.apiKeyPlaceholder')}
                className={ICON_INPUT_CONTROL}
              />
            </FormField>
            <button
              type="button"
              onClick={() => void onSaveCustom()}
              disabled={
                busy === 'custom' ||
                membershipBlocked ||
                !custom.model_name.trim() ||
                !custom.api_key.trim()
              }
              className="inline-flex h-11 items-center justify-center gap-2 rounded-md border border-transparent bg-primary px-4 text-sm font-medium text-on-primary shadow-[0_8px_18px_rgba(169,88,62,0.18)] transition-all duration-150 hover:bg-primary-active active:scale-[0.98] disabled:cursor-not-allowed disabled:border-hairline disabled:bg-surface-cream-strong disabled:text-muted-soft disabled:shadow-none disabled:active:scale-100"
            >
              {busy === 'custom' ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Save size={14} />
              )}
              {t('pages.modelSettings.saveModel')}
            </button>
          </div>
        </div>

        <aside className="border-t border-hairline/70 bg-canvas/45 p-4 sm:p-5 lg:border-l lg:border-t-0">
          <div className="text-[11px] font-semibold text-muted">
            {t('pages.modelSettings.connectionStatus')}
          </div>
          <div className="mt-2 flex items-center gap-2 text-[13px] font-semibold text-ink">
            <ShieldCheck size={15} className="text-primary" />
            {selected
              ? t('pages.modelSettings.usingCustom')
              : t('pages.modelSettings.customNotEnabled')}
          </div>
          <div className="mt-4 space-y-3 border-y border-hairline/70 py-4">
            <div>
              <div className="flex items-center gap-1.5 text-[10px] font-medium text-muted">
                <Sparkles size={12} className="text-primary" />
                {t('pages.modelSettings.summaryCustomAccess')}
              </div>
              <div className="mt-1 text-[13px] font-semibold text-ink">
                {membershipBadge}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-medium text-muted">
                {t('pages.modelSettings.currentModelName')}
              </div>
              <div className="mt-1 truncate text-[13px] font-semibold text-ink">
                {custom.model_name.trim() || t('pages.modelSettings.notFilled')}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void onSelectCustom()}
            disabled={busy === 'select-custom' || membershipBlocked}
            className={`mt-4 inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg px-3 text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              selected
                ? 'bg-primary/15 text-primary'
                : 'border border-hairline bg-surface-card text-muted hover:bg-surface-cream-strong hover:text-ink'
            }`}
          >
            <Check size={14} />
            {selected
              ? t('pages.modelSettings.selectCustomCurrent')
              : t('pages.modelSettings.selectCustom')}
          </button>
          {membershipBlocked && (
            <Link
              href="/membership"
              className="mt-2 inline-flex h-10 w-full items-center justify-center rounded-lg border border-primary/25 bg-primary/10 px-3 text-[12px] font-medium text-primary transition-colors hover:border-primary/40 hover:bg-primary/15"
            >
              {t('pages.modelSettings.openMembership')}
            </Link>
          )}
        </aside>
      </div>
    </section>
  );
}

function CustomModelFields({
  custom,
  setCustom,
  t,
}: {
  custom: CustomDraft;
  setCustom: Dispatch<SetStateAction<CustomDraft>>;
  t: TranslationFn;
}) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <ProtocolSelectField
        value={custom.pi_api}
        t={t}
        onChange={(value) =>
          setCustom((prev) => ({
            ...prev,
            pi_api: value,
          }))
        }
      />
      <TextField
        label={t('pages.modelSettings.modelName')}
        icon={<Brain size={15} />}
        value={custom.model_name}
        onChange={(value) =>
          setCustom((prev) => ({ ...prev, model_name: value }))
        }
      />
      <TextField
        label={t('pages.modelSettings.contextWindow')}
        icon={<Hash size={15} />}
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
        icon={<Link2 size={15} />}
        value={custom.base_url}
        placeholder={t('pages.modelSettings.optional')}
        onChange={(value) =>
          setCustom((prev) => ({ ...prev, base_url: value }))
        }
      />
    </div>
  );
}

function ProtocolSelectField({
  value,
  t,
  onChange,
}: {
  value: ModelPiApi;
  t: TranslationFn;
  onChange: (value: ModelPiApi) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedOption =
    PI_API_OPTIONS.find((option) => option.value === value) ??
    PI_API_OPTIONS[0];

  useEffect(() => {
    if (!open) return;

    const closeOnOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="group relative min-w-0 space-y-1.5">
      <span className="text-[12px] font-medium text-muted">
        {t('pages.modelSettings.protocolType')}
      </span>
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 z-10 flex h-5 w-5 -translate-y-1/2 items-center justify-center text-muted-soft transition-colors group-focus-within:text-primary">
          <Cpu size={15} />
        </span>
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={t('pages.modelSettings.protocolCurrent', {
            protocol: selectedOption.label,
          })}
          onClick={() => setOpen((current) => !current)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setOpen(true);
            }
          }}
          className={`flex items-center gap-3 pl-10 pr-10 text-left ${CONTROL} ${
            open
              ? 'border-primary/60 bg-canvas shadow-[0_0_0_3px_rgba(204,120,92,0.13)]'
              : ''
          }`}
        >
          <span className="min-w-0 flex-1 truncate font-mono text-[14px]">
            {selectedOption.label}
          </span>
        </button>
        <ChevronDown
          size={15}
          className={`pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-soft transition-all duration-150 group-focus-within:text-primary ${
            open ? 'rotate-180 text-primary' : ''
          }`}
        />
        {open && (
          <div className="absolute left-0 right-0 top-full z-30 mt-2 overflow-hidden rounded-md border border-hairline bg-surface-card shadow-[0_14px_34px_rgba(0,0,0,0.12)] animate-scale-in">
            <div
              role="listbox"
              aria-label={t('pages.modelSettings.chooseProtocol')}
              className="space-y-1 p-1.5"
            >
              {PI_API_OPTIONS.map((option) => {
                const selected = option.value === value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      setOpen(false);
                      if (!selected) onChange(option.value);
                    }}
                    className={`flex min-h-10 w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors ${
                      selected
                        ? 'bg-primary/12 text-primary'
                        : 'text-ink hover:bg-surface-cream-strong'
                    }`}
                  >
                    <span
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border ${
                        selected
                          ? 'border-primary/30 bg-primary/10 text-primary'
                          : 'border-hairline bg-canvas text-muted-soft'
                      }`}
                    >
                      {selected ? <Check size={14} /> : <Cpu size={14} />}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-medium">
                      {option.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function FormField({
  label,
  icon,
  children,
}: {
  label: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="group block min-w-0 space-y-1.5">
      <span className="text-[12px] font-medium text-muted">
        {label}
      </span>
      <span className="relative block">
        <span className="pointer-events-none absolute left-3 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center text-muted-soft transition-colors group-focus-within:text-primary">
          {icon}
        </span>
        {children}
      </span>
    </label>
  );
}
function OfficialModelsSection({
  busy,
  models,
  selection,
  t,
  onSelectOfficial,
}: {
  busy: string;
  models: OfficialModel[];
  selection: ModelSettingsOverview['selection'];
  t: TranslationFn;
  onSelectOfficial: (modelId: string) => Promise<void>;
}) {
  const availableCount = models.filter(
    (model) => model.enabled && model.has_secret,
  ).length;

  return (
    <section className="rounded-lg border border-hairline bg-surface-card p-4 sm:p-5">
      <div className="flex flex-col gap-3 border-b border-hairline/70 pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-hairline bg-canvas text-primary">
            <Sparkles size={16} />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-ink">
              {t('pages.modelSettings.officialTitle')}
            </div>
            <div className="mt-1 text-[12px] leading-5 text-muted">
              {t('pages.modelSettings.officialDescription')}
            </div>
          </div>
        </div>
        <span className="inline-flex shrink-0 items-center rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 text-[10px] font-medium text-primary">
          {t('pages.modelSettings.officialAvailableCount', {
            available: availableCount,
            total: models.length,
          })}
        </span>
      </div>
      {models.length === 0 ? (
        <div className="mt-4 rounded-lg border border-hairline bg-canvas/55 px-4 py-6 text-[13px] text-muted">
          {t('pages.modelSettings.noOfficialModels')}
        </div>
      ) : (
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {models.map((model) => (
            <OfficialModelOption
              key={model.id}
              busy={busy === model.id}
              model={model}
              selected={
                selection?.source === 'official' &&
                selection.official_model_id === model.id
              }
              t={t}
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
  t,
  onSelect,
}: {
  busy: boolean;
  model: OfficialModel;
  selected: boolean;
  t: TranslationFn;
  onSelect: () => Promise<void>;
}) {
  const available = model.enabled && model.has_secret;
  const description =
    model.description ||
    t('pages.modelSettings.defaultOfficialDescription');
  return (
    <button
      type="button"
      onClick={() => void onSelect()}
      disabled={!available || busy}
      className={`flex min-h-[150px] flex-col justify-between rounded-lg border px-3.5 py-3.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        selected
          ? 'border-primary bg-primary/10 shadow-[0_8px_18px_rgba(0,0,0,0.06)]'
          : 'border-hairline bg-canvas/55 hover:border-primary/35 hover:bg-surface-cream-strong'
      }`}
    >
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">
            {model.display_name}
          </span>
          {selected && (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[10px] font-medium text-on-primary">
              <Check size={11} />
              {t('pages.modelSettings.current')}
            </span>
          )}
          {!available && (
            <span className="rounded-full bg-surface-card px-2 py-0.5 text-[10px] text-muted">
              {t('pages.modelSettings.unavailable')}
            </span>
          )}
        </div>
        <div className="mt-2 text-[12px] leading-5 text-muted">
          {description}
        </div>
      </div>
      <div className="mt-4 border-t border-hairline/60 pt-3">
        <OfficialModelPriceTags model={model} compact />
      </div>
    </button>
  );
}

function TextField({
  label,
  icon,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  icon: ReactNode;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <FormField label={label} icon={icon}>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={ICON_INPUT_CONTROL}
      />
    </FormField>
  );
}
