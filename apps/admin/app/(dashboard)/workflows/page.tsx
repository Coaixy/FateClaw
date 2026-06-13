'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  SimpleModelPolicyModeDto,
  SimpleModelThinkingLevelDto,
} from '@fateclaw/contracts/chat';
import {
  admin,
  type AdminModelProvider,
  type AdminSimpleWorkflowPreset,
  type AdminSimpleWorkflowPresetUpdate,
  type AdminWorkflowSkillSummary,
} from '@/lib/admin-api';
import {
  Bot,
  Check,
  ChevronDown,
  Loader2,
  RefreshCw,
  Save,
  Workflow,
} from 'lucide-react';

type WorkflowDraft = {
  enabled: boolean;
  entryTitle: string;
  entryDescription: string;
  modelChoice: string;
  thinkingLevel: SimpleModelThinkingLevelDto;
  ichingMethod: string;
  baziIncludes: string[];
  skillIds: string[];
};

type WorkflowSelectOption<T extends string> = {
  value: T;
  label: string;
  description?: string;
};

const KIND_LABELS: Record<AdminSimpleWorkflowPreset['kind'], string> = {
  divination: '占卜问事',
  natal: '命理分析',
};

const ICHING_METHOD_OPTIONS = [
  { value: 'dayan', label: '大衍筮法' },
  { value: 'lueshifa', label: '略筮法' },
  { value: 'time', label: '按当前时间' },
];

const BAZI_INCLUDE_OPTIONS = [
  { value: 'bazi', label: '八字本盘' },
  { value: 'fortune', label: '大运流年' },
  { value: 'pattern', label: '格局倾向' },
];

const THINKING_LEVEL_OPTIONS: Array<{
  value: SimpleModelThinkingLevelDto;
  label: string;
}> = [
  { value: 'off', label: '关闭' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '极高' },
];

const inputClassName =
  'h-10 w-full rounded-md border border-hairline bg-canvas px-3 text-[13px] text-ink outline-none transition-colors focus:border-primary/50 disabled:opacity-50';
const SAVE_TIMEOUT_MS = 15_000;

function modelChoiceFromPreset(preset: AdminSimpleWorkflowPreset): string {
  if (preset.model_policy.mode === 'fixed') {
    return `fixed:${preset.model_policy.fixedModelId ?? ''}`;
  }
  return preset.model_policy.mode;
}

function draftFromPreset(preset: AdminSimpleWorkflowPreset): WorkflowDraft {
  const include = preset.paipan_input_defaults.include;
  return {
    enabled: preset.enabled,
    entryTitle: preset.entry_title,
    entryDescription: preset.entry_description,
    modelChoice: modelChoiceFromPreset(preset),
    thinkingLevel: preset.model_policy.thinkingLevel ?? 'medium',
    ichingMethod:
      typeof preset.paipan_input_defaults.method === 'string'
        ? preset.paipan_input_defaults.method
        : 'dayan',
    baziIncludes:
      Array.isArray(include) && include.length > 0
        ? include.map(String)
        : ['bazi', 'fortune', 'pattern'],
    skillIds: preset.skill_ids,
  };
}

function buildModelPolicy(draft: WorkflowDraft): {
  mode: SimpleModelPolicyModeDto;
  fixedModelId?: string;
  thinkingLevel: SimpleModelThinkingLevelDto;
} {
  if (draft.modelChoice.startsWith('fixed:')) {
    return {
      mode: 'fixed',
      fixedModelId: draft.modelChoice.slice('fixed:'.length),
      thinkingLevel: draft.thinkingLevel,
    };
  }
  return {
    mode: draft.modelChoice as SimpleModelPolicyModeDto,
    thinkingLevel: draft.thinkingLevel,
  };
}

function toggleValue(values: string[], value: string): string[] {
  return values.includes(value)
    ? values.filter((item) => item !== value)
    : [...values, value];
}

function sameStringArray(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function buildUpdatePayload(
  preset: AdminSimpleWorkflowPreset,
  draft: WorkflowDraft,
):
  | { ok: true; value: AdminSimpleWorkflowPresetUpdate }
  | { ok: false; error: string } {
  if (preset.kind === 'natal' && draft.baziIncludes.length === 0) {
    return { ok: false, error: '命理分析至少选择一个输出内容' };
  }
  if (draft.modelChoice === 'fixed:') {
    return { ok: false, error: '请选择固定模型' };
  }

  const value: AdminSimpleWorkflowPresetUpdate = {
    enabled: draft.enabled,
    entry_title: draft.entryTitle.trim(),
    entry_description: draft.entryDescription.trim(),
    paipan_input_defaults:
      preset.kind === 'divination'
        ? { method: draft.ichingMethod }
        : { include: draft.baziIncludes },
    model_policy: buildModelPolicy(draft),
  };
  if (!sameStringArray(preset.skill_ids, draft.skillIds)) {
    value.skill_ids = draft.skillIds;
  }

  return {
    ok: true,
    value,
  };
}

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <span className="mb-1.5 block text-[12px] font-medium text-muted">
      {children}
    </span>
  );
}

function WorkflowSelect<T extends string>({
  value,
  options,
  disabled,
  label,
  onChange,
}: {
  value: T;
  options: Array<WorkflowSelectOption<T>>;
  disabled: boolean;
  label: string;
  onChange: (value: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        className={`flex h-10 w-full items-center gap-2 rounded-md border bg-canvas px-3 text-left text-[13px] text-ink outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          open
            ? 'border-primary/55 ring-2 ring-primary/10'
            : 'border-hairline hover:border-primary/30 focus:border-primary/50'
        }`}
      >
        <span className="min-w-0 flex-1 truncate">
          {selected?.label ?? '请选择'}
        </span>
        <ChevronDown
          size={15}
          className={`shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-40 mt-1.5 overflow-hidden rounded-md border border-hairline bg-surface-card shadow-lg">
          <div
            role="listbox"
            aria-label={label}
            className="max-h-72 overflow-y-auto p-1"
          >
            {options.map((option) => {
              const selectedOption = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={selectedOption}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className={`flex w-full items-start gap-2 rounded px-2.5 py-2 text-left transition-colors ${
                    selectedOption
                      ? 'bg-primary/10 text-primary'
                      : 'text-ink hover:bg-canvas'
                  }`}
                >
                  <span
                    className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                      selectedOption
                        ? 'border-primary bg-primary text-on-primary'
                        : 'border-hairline bg-canvas'
                    }`}
                  >
                    {selectedOption && <Check size={11} strokeWidth={3} />}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium">
                      {option.label}
                    </span>
                    {option.description && (
                      <span className="mt-0.5 block truncate text-[11px] text-muted">
                        {option.description}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function OptionPill({
  selected,
  disabled,
  children,
  onClick,
}: {
  selected: boolean;
  disabled: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex min-h-10 items-center gap-2 rounded-md border px-3 text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        selected
          ? 'border-primary/45 bg-primary/10 text-primary'
          : 'border-hairline bg-canvas text-muted hover:text-ink'
      }`}
    >
      <span
        className={`flex h-4 w-4 items-center justify-center rounded border ${
          selected
            ? 'border-primary bg-primary text-on-primary'
            : 'border-hairline'
        }`}
      >
        {selected && <Check size={11} strokeWidth={3} />}
      </span>
      {children}
    </button>
  );
}

function SkillSelector({
  skills,
  selectedIds,
  disabled,
  onChange,
}: {
  skills: AdminWorkflowSkillSummary[];
  selectedIds: string[];
  disabled: boolean;
  onChange: (ids: string[]) => void;
}) {
  if (skills.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-hairline px-3 py-6 text-center text-[12px] text-muted">
        暂无可绑定的 Skill。
      </div>
    );
  }

  return (
    <div className="grid gap-2 lg:grid-cols-2">
      {skills.map((skill) => {
        const selected = selectedIds.includes(skill.id);
        return (
          <button
            key={skill.id}
            type="button"
            onClick={() => onChange(toggleValue(selectedIds, skill.id))}
            disabled={disabled}
            className={`min-h-20 rounded-md border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              selected
                ? 'border-primary/45 bg-primary/10'
                : 'border-hairline bg-canvas hover:border-primary/30'
            }`}
          >
            <span className="flex items-start gap-2">
              <span
                className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                  selected
                    ? 'border-primary bg-primary text-on-primary'
                    : 'border-hairline'
                }`}
              >
                {selected && <Check size={11} strokeWidth={3} />}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium text-ink">
                  {skill.skill_name}
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-muted">
                  {skill.owner_phone || skill.user_id}
                </span>
                <span className="mt-1 block text-[11px] leading-5 text-muted">
                  {skill.description || skill.dir_name}
                </span>
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function WorkflowPresetPanel({
  preset,
  officialModels,
  skills,
  busy,
  onSave,
}: {
  preset: AdminSimpleWorkflowPreset;
  officialModels: AdminModelProvider[];
  skills: AdminWorkflowSkillSummary[];
  busy: boolean;
  onSave: (
    id: string,
    payload: AdminSimpleWorkflowPresetUpdate,
  ) => Promise<void>;
}) {
  const [draft, setDraft] = useState<WorkflowDraft>(() =>
    draftFromPreset(preset),
  );
  const [localError, setLocalError] = useState('');

  useEffect(() => {
    setDraft(draftFromPreset(preset));
    setLocalError('');
  }, [preset]);

  const modelOptions = useMemo(
    () => [
      {
        value: 'user-current',
        label: '用户当前模型',
        description: '跟随用户自己的模型设置',
      },
      {
        value: 'system-default',
        label: '系统默认模型',
        description: '使用后台可用模型兜底',
      },
      ...officialModels.map((model) => ({
        value: `fixed:${model.id}`,
        label: model.display_name,
        description: model.model_name,
      })),
    ],
    [officialModels],
  );

  const updateDraft = <K extends keyof WorkflowDraft>(
    key: K,
    value: WorkflowDraft[K],
  ) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const handleSave = async () => {
    const payload = buildUpdatePayload(preset, draft);
    if (!payload.ok) {
      setLocalError(payload.error);
      return;
    }
    setLocalError('');
    await onSave(preset.id, payload.value);
  };

  return (
    <section className="rounded-lg border border-hairline bg-surface-card/70 p-4 shadow-sm sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[16px] font-semibold text-ink">
              {KIND_LABELS[preset.kind]}
            </h3>
            <span className="rounded-md border border-hairline bg-canvas px-2 py-0.5 text-[11px] text-muted">
              {preset.paipan_skill === 'iching-paipan' ? '六爻' : '八字'}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={busy}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-3 text-[13px] font-medium text-on-primary transition-colors hover:bg-primary-active disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Save size={14} />
          )}
          保存
        </button>
      </div>

      {localError && (
        <div className="mt-3 rounded-md border border-error/30 bg-error/8 px-3 py-2 text-[12px] text-error">
          {localError}
        </div>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label>
          <FieldLabel>入口标题</FieldLabel>
          <input
            value={draft.entryTitle}
            onChange={(event) => updateDraft('entryTitle', event.target.value)}
            disabled={busy}
            className={inputClassName}
          />
        </label>
        <label>
          <FieldLabel>入口描述</FieldLabel>
          <input
            value={draft.entryDescription}
            onChange={(event) =>
              updateDraft('entryDescription', event.target.value)
            }
            disabled={busy}
            className={inputClassName}
          />
        </label>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <OptionPill
          selected={draft.enabled}
          disabled={busy}
          onClick={() => updateDraft('enabled', !draft.enabled)}
        >
          启用
        </OptionPill>
      </div>

      <div className="mt-5 grid gap-3 lg:grid-cols-2">
        <div>
          <FieldLabel>模型</FieldLabel>
          <WorkflowSelect
            label="模型"
            value={draft.modelChoice}
            options={modelOptions}
            disabled={busy}
            onChange={(value) => updateDraft('modelChoice', value)}
          />
        </div>
        <div>
          <FieldLabel>思考等级</FieldLabel>
          <WorkflowSelect
            label="思考等级"
            value={draft.thinkingLevel}
            options={THINKING_LEVEL_OPTIONS}
            disabled={busy}
            onChange={(value) => updateDraft('thinkingLevel', value)}
          />
        </div>
      </div>

      <div className="mt-5">
        <FieldLabel>
          {preset.kind === 'divination' ? '六爻起卦方式' : '八字输出内容'}
        </FieldLabel>
        {preset.kind === 'divination' ? (
          <div className="flex flex-wrap gap-2">
            {ICHING_METHOD_OPTIONS.map((option) => (
              <OptionPill
                key={option.value}
                selected={draft.ichingMethod === option.value}
                disabled={busy}
                onClick={() => updateDraft('ichingMethod', option.value)}
              >
                {option.label}
              </OptionPill>
            ))}
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {BAZI_INCLUDE_OPTIONS.map((option) => (
              <OptionPill
                key={option.value}
                selected={draft.baziIncludes.includes(option.value)}
                disabled={busy}
                onClick={() =>
                  updateDraft(
                    'baziIncludes',
                    toggleValue(draft.baziIncludes, option.value),
                  )
                }
              >
                {option.label}
              </OptionPill>
            ))}
          </div>
        )}
      </div>

      <div className="mt-5">
        <FieldLabel>绑定 Skill</FieldLabel>
        <p className="mb-2 text-[11px] leading-5 text-muted">
          可选择用户的私有 Skill。保存后会复制当前 Skill 文件作为 Workflow 固定快照，后续原作者修改、删除或取消分享不会影响已保存配置。
        </p>
        <SkillSelector
          skills={skills}
          selectedIds={draft.skillIds}
          disabled={busy}
          onChange={(ids) => updateDraft('skillIds', ids)}
        />
      </div>
    </section>
  );
}

/**
 * 管理后台简易模式 workflow 配置页。
 *
 * @returns 简易模式占卜/命理 preset 的独立管理视图。
 */
export default function AdminWorkflowsPage() {
  const [presets, setPresets] = useState<AdminSimpleWorkflowPreset[]>([]);
  const [officialModels, setOfficialModels] = useState<AdminModelProvider[]>(
    [],
  );
  const [skills, setSkills] = useState<AdminWorkflowSkillSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [workflowData, systemData, resourceData] = await Promise.all([
        admin.simpleWorkflows(),
        admin.systemConfig(),
        admin.simpleWorkflowResources(),
      ]);
      setPresets(workflowData.presets);
      setOfficialModels(systemData.official_models);
      setSkills(resourceData.skills);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!busyId) return;
    const timeoutId = window.setTimeout(() => {
      setBusyId('');
      setError('保存超时，请检查网络或稍后重试');
    }, SAVE_TIMEOUT_MS);
    return () => window.clearTimeout(timeoutId);
  }, [busyId]);

  const handleSave = useCallback(
    async (id: string, payload: AdminSimpleWorkflowPresetUpdate) => {
      if (busyId) return;
      const controller = new AbortController();
      let timedOut = false;
      const timeoutId = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, SAVE_TIMEOUT_MS);

      setBusyId(id);
      setError('');
      try {
        const updated = await admin.updateSimpleWorkflowPreset(id, payload, {
          signal: controller.signal,
        });
        setPresets((current) =>
          current
            .map((preset) => (preset.id === id ? updated : preset))
            .sort((left, right) => left.sort_order - right.sort_order),
        );
      } catch (err) {
        setError(
          timedOut
            ? '保存超时，请检查网络或稍后重试'
            : err instanceof Error
              ? err.message
              : '保存失败',
        );
      } finally {
        window.clearTimeout(timeoutId);
        setBusyId('');
      }
    },
    [busyId],
  );

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 size={20} className="animate-spin text-muted" />
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Workflow size={16} className="text-muted" />
            <h2 className="text-lg font-semibold">Workflow 配置</h2>
          </div>
          <p className="mt-1 text-[13px] leading-6 text-muted">
            管理简易模式入口、模型、排盘方式和可见 Skill。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex h-10 items-center gap-1.5 rounded-md border border-hairline bg-surface-card px-3 text-[12px] text-muted">
            <Bot size={13} />
            {officialModels.length} 个官方模型
          </span>
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex h-10 items-center gap-2 rounded-md border border-hairline px-3 text-[13px] text-muted transition-colors hover:text-ink"
            title="刷新"
          >
            <RefreshCw size={13} />
            刷新
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-error/30 bg-error/8 px-4 py-3 text-[13px] text-error">
          {error}
        </div>
      )}

      {presets.length === 0 ? (
        <div className="rounded-lg border border-dashed border-hairline px-4 py-12 text-center text-[13px] text-muted">
          暂无 workflow preset。
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {presets.map((preset) => (
            <WorkflowPresetPanel
              key={preset.id}
              preset={preset}
              officialModels={officialModels}
              skills={skills}
              busy={busyId === preset.id}
              onSave={handleSave}
            />
          ))}
        </div>
      )}
    </div>
  );
}
