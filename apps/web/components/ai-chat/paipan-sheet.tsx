'use client';

import { type ReactNode, useEffect, useMemo, useReducer } from 'react';
import {
  ChevronDown,
  Loader2,
  MessageCircle,
  PencilLine,
  Sparkles,
} from 'lucide-react';

import { ArtifactRenderer } from '@/components/chat/artifact-renderer';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { Button } from '@/components/ui/button';
import { ClientProfileSelector } from '@/components/ai-chat/client-profile-selector';
import {
  resolvePaipanFlow,
  type PaipanFlowFieldKit,
} from '@/components/ai-chat/paipan-flows';
import {
  PAIPAN_FLOW_HELPERS,
  PAIPAN_SHEET_HELPERS,
} from '@/components/ai-chat/paipan-sheet-helpers';
import type { ClientProfile } from '@/features/chat/client-profiles-api';
import {
  type PaipanCatalogItem,
  type PaipanCommitResponse,
  type PaipanPreviewResponse,
  type PaipanSchema,
  paipanApi,
} from '@/features/paipan/api';
import { useI18n } from '@/lib/i18n';
import { useToast } from '@/lib/use-toast';

/**
 * 支持按客户档案预填生辰的术数集合。
 *
 * 仅八字、紫微以个人出生年月日时 + 性别为输入，关联客户档案预填才有意义；
 * 其余术数（卦例、奇门等）以事件时间或起卦数为输入，不展示客户选择器。
 */
const CLIENT_PREFILL_SKILLS = new Set(['bazi-paipan', 'ziwei-paipan']);

type PaipanSheetMode = 'pre-chat' | 'current-session';

interface PaipanSheetProps {
  open: boolean;
  mode: PaipanSheetMode;
  catalog: PaipanCatalogItem[];
  catalogLoading: boolean;
  sessionId?: string;
  initialSkill?: string | null;
  /** 外部带入需自动预选并预填的客户 id（如客户卡片"发起排盘"）。 */
  initialClientId?: string | null;
  lockSkill?: boolean;
  canCommit?: boolean;
  onClose: () => void;
  onAuthRequired?: () => void;
  onCommitted: (result: PaipanCommitResponse) => Promise<void> | void;
}

const {
  buildDateTimePickerValue,
  buildInitialDraftForSkill,
  buildSubmitInputForSkill,
  formatArrayInputValue,
  getFieldCopy,
  getOptionLabel,
  getPrimaryType,
  getSimpleHiddenFieldPaths,
  getValueAtPath,
  hasVisibleSchemaFields,
  isValidInteger,
  pad2,
  parseDateTimePickerValue,
  parseDelimitedArrayInput,
  setValueAtPath,
  validateDraftForSkill,
} = PAIPAN_SHEET_HELPERS;

const PAIPAN_FLOW_FIELD_KIT: PaipanFlowFieldKit = {
  DateField,
  TimeField,
  DateTimeField,
  ChoiceGrid,
  SelectField,
  FieldTextInput,
};

function PropertyDescription({ text }: { text?: string }) {
  if (!text) return null;
  return <p className="mt-1 text-[11px] leading-5 text-muted">{text}</p>;
}

function FieldLabel({
  title,
  required,
}: {
  title: string;
  required?: boolean;
}) {
  return (
    <div className="mb-1.5 flex items-center gap-1">
      <span className="text-[11px] sm:text-[12px] font-medium text-ink">
        {title}
      </span>
      {required && <span className="text-[11px] text-rose-400">*</span>}
    </div>
  );
}

function FormField({ children }: { children: ReactNode }) {
  return <div className="min-w-0">{children}</div>;
}

function FieldTextInput({
  title,
  required,
  description,
  value,
  placeholder,
  onChange,
}: {
  title: string;
  required?: boolean;
  description?: string;
  value: string;
  placeholder?: string;
  onChange: (value: string | undefined) => void;
}) {
  return (
    <FormField>
      <FieldLabel title={title} required={required} />
      <input
        type="text"
        value={value}
        onChange={(event) =>
          onChange(event.currentTarget.value.trim() || undefined)
        }
        placeholder={placeholder}
        className="min-h-10 w-full rounded-xl border border-hairline bg-surface-card px-3 py-2 text-[13px] text-ink placeholder:text-muted/60 focus:border-primary/40 focus:outline-none"
      />
      <PropertyDescription text={description} />
    </FormField>
  );
}

type PaipanDateTimeFieldMode = 'date' | 'time' | 'datetime';

type PaipanDateTimeFieldValue = {
  date?: string;
  hour?: unknown;
  minute?: unknown;
};

function PaipanDateTimeField({
  title,
  description,
  required,
  value,
  mode,
  onChange,
}: {
  title: string;
  description?: string;
  required?: boolean;
  value: PaipanDateTimeFieldValue;
  mode: PaipanDateTimeFieldMode;
  onChange: (value: { date?: string; hour?: number; minute?: number }) => void;
}) {
  const time = isValidInteger(value.hour)
    ? `${pad2(value.hour)}:${pad2(isValidInteger(value.minute) ? value.minute : 0)}`
    : '';
  const date = value.date ?? '';
  const inputValue =
    mode === 'date'
      ? date
      : mode === 'time'
        ? time
        : date && time
          ? `${date}T${time}`
          : '';

  return (
    <FormField>
      <FieldLabel title={title} required={required} />
      <input
        type={mode === 'datetime' ? 'datetime-local' : mode}
        aria-label={title}
        required={required}
        value={inputValue}
        min={
          mode === 'time'
            ? undefined
            : `1900-01-01${mode === 'datetime' ? 'T00:00' : ''}`
        }
        max={
          mode === 'time'
            ? undefined
            : `2100-12-31${mode === 'datetime' ? 'T23:59' : ''}`
        }
        step={mode === 'date' ? undefined : 60}
        onChange={(event) => {
          const raw = event.currentTarget.value;
          if (mode === 'date') {
            onChange({ date: raw || undefined });
            return;
          }
          if (mode === 'datetime') {
            onChange(parseDateTimePickerValue(raw));
            return;
          }
          const [hour, minute] = raw.split(':');
          onChange({
            hour: raw ? Number(hour) : undefined,
            minute: raw ? Number(minute) : undefined,
          });
        }}
        className="h-11 w-full min-w-0 rounded-xl border border-hairline bg-canvas px-3 text-[16px] text-ink focus:border-primary/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 sm:text-[14px]"
      />
      <PropertyDescription text={description} />
    </FormField>
  );
}

function DateField({
  title,
  description,
  required,
  value,
  onChange,
}: {
  title: string;
  description?: string;
  required?: boolean;
  value: string;
  onChange: (value: string | undefined) => void;
}) {
  return (
    <PaipanDateTimeField
      title={title}
      description={description}
      required={required}
      mode="date"
      value={{ date: value }}
      onChange={(next) => onChange(next.date)}
    />
  );
}

function TimeField({
  title,
  description,
  required,
  hour,
  minute,
  onChange,
}: {
  title: string;
  description?: string;
  required?: boolean;
  hour: unknown;
  minute: unknown;
  onChange: (next: { hour?: number; minute?: number }) => void;
}) {
  return (
    <PaipanDateTimeField
      title={title}
      description={description}
      required={required}
      mode="time"
      value={{ hour, minute }}
      onChange={(next) => onChange({ hour: next.hour, minute: next.minute })}
    />
  );
}

function DateTimeField({
  title,
  description,
  required,
  value,
  onChange,
}: {
  title: string;
  description?: string;
  required?: boolean;
  value: unknown;
  onChange: (value: string | undefined) => void;
}) {
  return (
    <PaipanDateTimeField
      title={title}
      description={description}
      required={required}
      mode="datetime"
      value={parseDateTimePickerValue(value)}
      onChange={(next) => onChange(buildDateTimePickerValue(next))}
    />
  );
}

function ChoiceGrid({
  title,
  description,
  required,
  value,
  options,
  onChange,
}: {
  title: string;
  description?: string;
  required?: boolean;
  value: string | undefined;
  options: Array<{
    value: string;
    label: string;
    hint?: string;
  }>;
  onChange: (value: string) => void;
}) {
  return (
    <FormField>
      <FieldLabel title={title} required={required} />
      <div role="group" aria-label={title} className="flex flex-wrap gap-2">
        {options.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              title={option.hint}
              onClick={() => onChange(option.value)}
              className={`inline-flex h-11 min-w-14 items-center justify-center rounded-lg border px-3 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 ${
                active
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-hairline bg-canvas text-muted hover:border-primary/30 hover:text-ink'
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      <PropertyDescription text={description} />
    </FormField>
  );
}

function SelectField({
  title,
  description,
  required,
  value,
  placeholder,
  options,
  onChange,
}: {
  title: string;
  description?: string;
  required?: boolean;
  value: string | undefined;
  placeholder?: string;
  options: Array<{
    value: string;
    label: string;
    hint?: string;
  }>;
  onChange: (value: string | undefined) => void;
}) {
  return (
    <FormField>
      <FieldLabel title={title} required={required} />
      <select
        aria-label={title}
        required={required}
        value={value ?? ''}
        onChange={(event) =>
          onChange(event.currentTarget.value || undefined)
        }
        className="h-11 w-full min-w-0 rounded-xl border border-hairline bg-canvas px-3 text-[16px] text-ink focus:border-primary/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 sm:text-[14px]"
      >
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.hint ? `${option.label} · ${option.hint}` : option.label}
          </option>
        ))}
      </select>
      <PropertyDescription text={description} />
    </FormField>
  );
}

function SchemaFields({
  schema,
  draft,
  pathPrefix = [],
  hiddenPaths,
  t,
  onChange,
}: {
  schema?: PaipanSchema;
  draft: Record<string, unknown>;
  pathPrefix?: string[];
  hiddenPaths: Set<string>;
  t: ReturnType<typeof useI18n>['t'];
  onChange: (path: string[], value: unknown) => void;
}) {
  if (!schema) return null;

  const visibleEntries = Object.entries(schema.properties).filter(
    ([key, property]) => {
      const path = [...pathPrefix, key];
      const fieldPathKey = path.join('.');

      if (hiddenPaths.has(fieldPathKey)) {
        return false;
      }

      const type = getPrimaryType(property);
      if (type === 'object' && property.properties) {
        return hasVisibleSchemaFields(
          {
            type: 'object',
            properties: property.properties,
            required: property.required,
          },
          hiddenPaths,
          path,
        );
      }

      return true;
    },
  );

  if (visibleEntries.length === 0) {
    return null;
  }

  return (
    <div className="space-y-4">
      {visibleEntries.map(([key, property]) => {
        const path = [...pathPrefix, key];
        const fieldPathKey = path.join('.');
        const value = getValueAtPath(draft, path);
        const type = getPrimaryType(property);
        const required = schema.required?.includes(key);
        const copy = getFieldCopy(fieldPathKey, key, property.description, t);

        if (type === 'object' && property.properties) {
          return (
            <div
              key={fieldPathKey}
              className="rounded-2xl border border-hairline bg-surface-card/50 p-4"
            >
              <FieldLabel title={copy.label} required={required} />
              <PropertyDescription text={copy.description} />
              <div className="mt-3">
                <SchemaFields
                  schema={{
                    type: 'object',
                    properties: property.properties,
                    required: property.required,
                  }}
                  draft={draft}
                  pathPrefix={path}
                  hiddenPaths={hiddenPaths}
                  t={t}
                  onChange={onChange}
                />
              </div>
            </div>
          );
        }

        if (type === 'boolean') {
          return (
            <label
              key={fieldPathKey}
              className="flex cursor-pointer items-start gap-3 rounded-2xl border border-hairline bg-surface-card/50 px-4 py-3"
            >
              <input
                type="checkbox"
                checked={Boolean(value)}
                onChange={(event) =>
                  onChange(path, event.currentTarget.checked)
                }
                className="mt-1 h-4 w-4 rounded border-hairline bg-transparent accent-primary"
              />
              <div className="min-w-0">
                <FieldLabel title={copy.label} required={required} />
                <PropertyDescription text={copy.description} />
              </div>
            </label>
          );
        }

        if (
          type === 'array' &&
          property.items?.enum &&
          property.items.enum.length > 0
        ) {
          const selectedValues = Array.isArray(value) ? value : [];
          return (
            <div
              key={fieldPathKey}
              className="rounded-2xl border border-hairline bg-surface-card/50 p-4"
            >
              <FieldLabel title={copy.label} required={required} />
              <PropertyDescription text={copy.description} />
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {property.items.enum.map((option) => {
                  const label = getOptionLabel(fieldPathKey, option, t);
                  const checked = selectedValues.includes(option);
                  return (
                    <label
                      key={`${fieldPathKey}-${String(option)}`}
                      className="flex cursor-pointer items-center gap-2 rounded-xl border border-hairline px-3 py-2 text-[12px] text-ink"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) => {
                          const next = new Set(selectedValues);
                          if (event.currentTarget.checked) {
                            next.add(option);
                          } else {
                            next.delete(option);
                          }
                          onChange(path, Array.from(next));
                        }}
                        className="h-4 w-4 rounded border-hairline accent-primary"
                      />
                      <span>{label}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          );
        }

        if (property.enum && property.enum.length > 0) {
          return (
            <div key={fieldPathKey}>
              <FieldLabel title={copy.label} required={required} />
              <select
                value={typeof value === 'string' ? value : String(value ?? '')}
                onChange={(event) =>
                  onChange(path, event.currentTarget.value || undefined)
                }
                className="w-full rounded-2xl border border-hairline bg-surface-card px-3 py-2.5 text-[13px] text-ink focus:border-primary/40 focus:outline-none"
              >
                <option value="">
                  {t('aiChat.paipanSheet.selectPlaceholder')}
                </option>
                {property.enum.map((option) => (
                  <option
                    key={`${fieldPathKey}-${String(option)}`}
                    value={String(option)}
                  >
                    {getOptionLabel(fieldPathKey, option, t)}
                  </option>
                ))}
              </select>
              <PropertyDescription text={copy.description} />
            </div>
          );
        }

        if (type === 'array') {
          return (
            <div key={fieldPathKey}>
              <FieldLabel title={copy.label} required={required} />
              <input
                type="text"
                value={formatArrayInputValue(value)}
                onChange={(event) =>
                  onChange(
                    path,
                    parseDelimitedArrayInput(
                      event.currentTarget.value,
                      property.items?.type ?? 'string',
                    ),
                  )
                }
                className="w-full rounded-2xl border border-hairline bg-surface-card px-3 py-2.5 text-[13px] text-ink placeholder:text-muted/60 focus:border-primary/40 focus:outline-none"
                placeholder={
                  copy.placeholder ?? t('aiChat.paipanSheet.arrayPlaceholder')
                }
              />
              <PropertyDescription text={copy.description} />
            </div>
          );
        }

        if (type === 'integer' || type === 'number') {
          return (
            <div key={fieldPathKey}>
              <FieldLabel title={copy.label} required={required} />
              <input
                type="number"
                inputMode="numeric"
                min={property.minimum}
                max={property.maximum}
                value={typeof value === 'number' ? String(value) : ''}
                onChange={(event) => {
                  const raw = event.currentTarget.value.trim();
                  if (!raw) {
                    onChange(path, undefined);
                    return;
                  }
                  onChange(
                    path,
                    type === 'integer' ? Number.parseInt(raw, 10) : Number(raw),
                  );
                }}
                className="w-full rounded-2xl border border-hairline bg-surface-card px-3 py-2.5 text-[13px] text-ink placeholder:text-muted/60 focus:border-primary/40 focus:outline-none"
                placeholder={copy.placeholder}
              />
              <PropertyDescription text={copy.description} />
            </div>
          );
        }

        return (
          <div key={fieldPathKey}>
            <FieldLabel title={copy.label} required={required} />
            <input
              type="text"
              value={typeof value === 'string' ? value : ''}
              onChange={(event) =>
                onChange(path, event.currentTarget.value.trim() || undefined)
              }
              placeholder={copy.placeholder}
              className="w-full rounded-2xl border border-hairline bg-surface-card px-3 py-2.5 text-[13px] text-ink placeholder:text-muted/60 focus:border-primary/40 focus:outline-none"
            />
            <PropertyDescription text={copy.description} />
          </div>
        );
      })}
    </div>
  );
}

// The sheet owns the draft and its preview so editing cannot commit an obsolete chart.
type PaipanSheetState = {
  selectedSkill: string;
  selectedClientId: string | null;
  draft: Record<string, unknown>;
  previewResult: PaipanPreviewResponse | null;
  // previewSkillName 当前不参与渲染，仅作为预览快照的附带元数据保留。
  previewSkillName: string;
  submitting: boolean;
  advancedOpen: boolean;
};

type PaipanSheetAction =
  | {
      type: 'resolveSkill';
      catalog: PaipanCatalogItem[];
      initialSkill?: string | null;
    }
  | { type: 'selectSkill'; skill: string }
  | { type: 'clearForNoSkill' }
  | { type: 'applySkill'; draft: Record<string, unknown>; clearClient: boolean }
  | { type: 'changeDraft'; path: string[]; value: unknown }
  | {
      type: 'changeManyDraft';
      changes: Array<{ path: string[]; value: unknown }>;
    }
  | {
      type: 'selectClient';
      clientId: string | null;
      changes?: Array<{ path: string[]; value: unknown }>;
    }
  | { type: 'previewSuccess'; result: PaipanPreviewResponse; skillName: string }
  | { type: 'setSubmitting'; value: boolean }
  | { type: 'toggleAdvanced' }
  | { type: 'editInput' }
  | { type: 'reset' };

const INITIAL_PAIPAN_SHEET_STATE: PaipanSheetState = {
  selectedSkill: '',
  selectedClientId: null,
  draft: {},
  previewResult: null,
  previewSkillName: '',
  submitting: false,
  advancedOpen: false,
};

// Reset preview metadata together whenever its source input changes.
const PREVIEW_RESET = {
  previewResult: null,
  previewSkillName: '',
} as const;

function paipanSheetReducer(
  state: PaipanSheetState,
  action: PaipanSheetAction,
): PaipanSheetState {
  switch (action.type) {
    case 'resolveSkill': {
      // 打开弹层时按 initialSkill / 既有选择 / 目录首项的优先级解析所选术数。
      const { catalog, initialSkill } = action;
      if (catalog.length === 0) {
        return { ...state, selectedSkill: '' };
      }
      if (initialSkill && catalog.some((item) => item.skill === initialSkill)) {
        return { ...state, selectedSkill: initialSkill };
      }
      if (
        state.selectedSkill &&
        catalog.some((item) => item.skill === state.selectedSkill)
      ) {
        return state;
      }
      return { ...state, selectedSkill: catalog[0]?.skill ?? '' };
    }
    case 'selectSkill':
      return { ...state, selectedSkill: action.skill };
    case 'clearForNoSkill':
      return { ...state, draft: {} };
    case 'applySkill':
      // 切换术数：重建初始草稿、复位预览与高级区；不支持客户预填时清除客户关联。
      return {
        ...state,
        draft: action.draft,
        ...PREVIEW_RESET,
        advancedOpen: false,
        selectedClientId: action.clearClient ? null : state.selectedClientId,
      };
    case 'changeDraft':
      // 用户改单个字段：复位预览并写回草稿对应路径。
      return {
        ...state,
        ...PREVIEW_RESET,
        draft: setValueAtPath(state.draft, action.path, action.value),
      };
    case 'changeManyDraft':
      return {
        ...state,
        ...PREVIEW_RESET,
        draft: action.changes.reduce(
          (nextDraft, change) =>
            setValueAtPath(nextDraft, change.path, change.value),
          state.draft,
        ),
      };
    case 'selectClient': {
      // 选中客户：记录关联 id；若带来预填改动则复位预览并写入草稿（无改动则只改 id）。
      const next: PaipanSheetState = {
        ...state,
        selectedClientId: action.clientId,
      };
      if (action.changes && action.changes.length > 0) {
        return {
          ...next,
          ...PREVIEW_RESET,
          draft: action.changes.reduce(
            (nextDraft, change) =>
              setValueAtPath(nextDraft, change.path, change.value),
            next.draft,
          ),
        };
      }
      return next;
    }
    case 'previewSuccess':
      return {
        ...state,
        previewResult: action.result,
        previewSkillName: action.skillName,
      };
    case 'editInput':
      return { ...state, ...PREVIEW_RESET };
    case 'setSubmitting':
      return { ...state, submitting: action.value };
    case 'toggleAdvanced':
      return { ...state, advancedOpen: !state.advancedOpen };
    case 'reset':
      // 关闭弹层：复位除草稿外的所有字段。此处保留 draft，但 selectedSkill 归空后
      // 会触发 clearForNoSkill 在同一周期把 draft 清掉；重新打开时 applySkill 必定重建，
      // 故残留与否用户均观测不到。
      return { ...INITIAL_PAIPAN_SHEET_STATE, draft: state.draft };
    default:
      return state;
  }
}

export function PaipanSheet({
  open,
  mode,
  catalog,
  catalogLoading,
  sessionId,
  initialSkill,
  initialClientId,
  lockSkill = false,
  canCommit = true,
  onClose,
  onAuthRequired,
  onCommitted,
}: PaipanSheetProps) {
  const { toast } = useToast();
  const { t } = useI18n();
  const [sheet, dispatchSheet] = useReducer(
    paipanSheetReducer,
    INITIAL_PAIPAN_SHEET_STATE,
  );

  const selectedCatalogItem = useMemo(
    () => catalog.find((item) => item.skill === sheet.selectedSkill) ?? null,
    [catalog, sheet.selectedSkill],
  );
  const selectedFlow = selectedCatalogItem
    ? resolvePaipanFlow(selectedCatalogItem.skill)
    : null;
  const SelectedFlow = selectedFlow;

  const hiddenPaths = useMemo(
    () =>
      new Set(
        selectedCatalogItem
          ? getSimpleHiddenFieldPaths(selectedCatalogItem.skill)
          : [],
      ),
    [selectedCatalogItem],
  );

  const hasAdvancedFields = useMemo(
    () => hasVisibleSchemaFields(selectedCatalogItem?.parameters, hiddenPaths),
    [hiddenPaths, selectedCatalogItem],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    // 解析所选术数（initialSkill / 既有选择 / 目录首项）的优先级逻辑下沉到 reducer。
    dispatchSheet({ type: 'resolveSkill', catalog, initialSkill });
  }, [catalog, initialSkill, open]);

  useEffect(() => {
    if (!selectedCatalogItem) {
      dispatchSheet({ type: 'clearForNoSkill' });
      return;
    }
    // 每次切换术数时重建一份更适合普通用户的初始表单状态，并复位预览/高级区。
    dispatchSheet({
      type: 'applySkill',
      draft: buildInitialDraftForSkill(
        selectedCatalogItem.skill,
        selectedCatalogItem.parameters,
      ),
      // 切换到不支持客户预填的术数时清除客户关联，避免错把客户绑到无关会话。
      clearClient: !CLIENT_PREFILL_SKILLS.has(selectedCatalogItem.skill),
    });
  }, [selectedCatalogItem]);

  useEffect(() => {
    if (!open) {
      dispatchSheet({ type: 'reset' });
    }
  }, [open]);

  const handleChange = (path: string[], value: unknown) => {
    dispatchSheet({ type: 'changeDraft', path, value });
  };

  const handleManyChanges = (
    changes: Array<{ path: string[]; value: unknown }>,
  ) => {
    dispatchSheet({ type: 'changeManyDraft', changes });
  };

  // 选中（或清除）客户档案：记录关联 id，并把客户生辰预填到排盘表单的对应字段。
  const handleSelectClient = (profile: ClientProfile | null) => {
    if (!profile) {
      dispatchSheet({ type: 'selectClient', clientId: null });
      return;
    }

    const changes: Array<{ path: string[]; value: unknown }> = [];
    if (typeof profile.solar_date === 'string' && profile.solar_date) {
      changes.push({ path: ['solarDate'], value: profile.solar_date });
    }
    if (typeof profile.hour === 'number') {
      changes.push({ path: ['hour'], value: profile.hour });
      changes.push({
        path: ['minute'],
        value: typeof profile.minute === 'number' ? profile.minute : 0,
      });
    }
    if (profile.gender === '男' || profile.gender === '女') {
      changes.push({ path: ['gender'], value: profile.gender });
    }
    dispatchSheet({
      type: 'selectClient',
      clientId: profile.id ?? null,
      changes,
    });
  };

  const buildCurrentSubmitInput = (): Record<string, unknown> | null => {
    if (!selectedCatalogItem) {
      return null;
    }

    const validationError = validateDraftForSkill(
      selectedCatalogItem.skill,
      sheet.draft,
      t,
    );
    if (validationError) {
      toast('error', validationError);
      return null;
    }

    return buildSubmitInputForSkill(selectedCatalogItem.skill, sheet.draft);
  };

  const handlePreview = async () => {
    if (!selectedCatalogItem) {
      toast('error', t('aiChat.paipanSheet.toast.missingSkill'));
      return;
    }

    const submitInput = buildCurrentSubmitInput();
    if (!submitInput) {
      return;
    }

    dispatchSheet({ type: 'setSubmitting', value: true });
    try {
      const result = await paipanApi.preview({
        skill: selectedCatalogItem.skill,
        input: submitInput,
      });
      dispatchSheet({
        type: 'previewSuccess',
        result,
        skillName: selectedCatalogItem.name,
      });
    } catch (error) {
      toast(
        'error',
        error instanceof Error
          ? error.message
          : t('aiChat.paipanSheet.toast.previewFailed'),
      );
    } finally {
      dispatchSheet({ type: 'setSubmitting', value: false });
    }
  };

  const handleCommitIntoCurrentSession = async () => {
    if (!canCommit) {
      onAuthRequired?.();
      return;
    }

    if (!selectedCatalogItem || !sessionId) {
      toast('error', t('aiChat.paipanSheet.toast.missingSession'));
      return;
    }

    const submitInput = buildCurrentSubmitInput();
    if (!submitInput) {
      return;
    }

    dispatchSheet({ type: 'setSubmitting', value: true });
    try {
      const result = await paipanApi.commit({
        target: 'current_session',
        sessionId,
        skill: selectedCatalogItem.skill,
        input: submitInput,
        client_id: sheet.selectedClientId,
      });
      await onCommitted(result);
      onClose();
    } catch (error) {
      toast(
        'error',
        error instanceof Error
          ? error.message
          : t('aiChat.paipanSheet.toast.insertFailed'),
      );
    } finally {
      dispatchSheet({ type: 'setSubmitting', value: false });
    }
  };

  const handleStartChatFromPreview = async () => {
    if (!canCommit) {
      onAuthRequired?.();
      return;
    }

    if (!sheet.previewResult) {
      toast('error', t('aiChat.paipanSheet.toast.missingPreview'));
      return;
    }
    dispatchSheet({ type: 'setSubmitting', value: true });
    try {
      const result = await paipanApi.commit({
        target: 'new_session_from_preview',
        previewId: sheet.previewResult.previewId,
        client_id: sheet.selectedClientId,
      });
      await onCommitted(result);
      onClose();
    } catch (error) {
      toast(
        'error',
        error instanceof Error
          ? error.message
          : t('aiChat.paipanSheet.toast.createSessionFailed'),
      );
    } finally {
      dispatchSheet({ type: 'setSubmitting', value: false });
    }
  };

  const advancedContent =
    selectedCatalogItem && hasAdvancedFields ? (
      <div>
        <button
          type="button"
          onClick={() => dispatchSheet({ type: 'toggleAdvanced' })}
          aria-expanded={sheet.advancedOpen}
          className="inline-flex h-8 items-center gap-1.5 text-[12px] text-muted hover:text-ink"
        >
          {t('aiChat.paipanSheet.advancedTitle')}
          <ChevronDown
            size={13}
            className={`shrink-0 text-muted transition-transform duration-200 ${
              sheet.advancedOpen ? 'rotate-180' : ''
            }`}
          />
        </button>

        {sheet.advancedOpen && (
          <div className="mt-2 border-t border-hairline pt-3">
            <SchemaFields
              schema={selectedCatalogItem.parameters}
              draft={sheet.draft}
              hiddenPaths={hiddenPaths}
              t={t}
              onChange={handleChange}
            />
          </div>
        )}
      </div>
    ) : null;

  const flowFinalAction = (
    <Button
      onClick={() => void handlePreview()}
      loading={sheet.submitting}
      icon={<Sparkles size={14} />}
      className="h-9 w-full rounded-xl text-[12px] sm:w-auto sm:rounded-lg"
    >
      {t('aiChat.paipanSheet.actions.generatePreview')}
    </Button>
  );
  const flowResultAction =
    mode === 'pre-chat' ? (
      <Button
        onClick={() => void handleStartChatFromPreview()}
        loading={sheet.submitting}
        icon={<MessageCircle size={14} />}
        className="h-9 w-full rounded-xl text-[12px] sm:w-auto sm:rounded-lg"
      >
        {canCommit
          ? t('aiChat.paipanSheet.actions.startChat')
          : t('aiChat.paipanSheet.actions.loginStartChat')}
      </Button>
    ) : (
      <Button
        onClick={() => void handleCommitIntoCurrentSession()}
        loading={sheet.submitting}
        icon={<Sparkles size={14} />}
        className="h-9 w-full rounded-xl text-[12px] sm:w-auto sm:rounded-lg"
      >
        {canCommit
          ? t('aiChat.paipanSheet.actions.insertCurrent')
          : t('aiChat.paipanSheet.actions.loginInsertCurrent')}
      </Button>
    );
  const flowResultContent = sheet.previewResult ? (
    <div className="rounded-[24px] border border-hairline bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.015))] p-2 sm:p-3">
      <ArtifactRenderer
        fitViewportHeight
        entries={[
          {
            skill: sheet.previewResult.skillContextEntry.skill,
            output: sheet.previewResult.skillContextEntry.output,
            artifactType: sheet.previewResult.skillContextEntry.artifactType,
            artifactTitle: sheet.previewResult.skillContextEntry.artifactTitle,
            artifactData: sheet.previewResult.skillContextEntry.artifactData,
          },
        ]}
      />
    </div>
  ) : null;
  // 结果页主动作固定在弹层底部；只保留按钮，把垂直空间让给盘面本身。
  const resultFooter = sheet.previewResult ? (
    <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
      <Button
        variant="secondary"
        disabled={sheet.submitting}
        icon={<PencilLine size={14} />}
        onClick={() => dispatchSheet({ type: 'editInput' })}
        className="h-9 shrink-0 rounded-xl text-[12px] sm:rounded-lg"
      >
        {t('aiChat.paipanSheet.actions.editInput')}
      </Button>
      {flowResultAction}
    </div>
  ) : null;

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      variant={sheet.previewResult ? 'fullscreen-sheet' : 'sheet'}
      fillHeight={Boolean(sheet.previewResult)}
      size={sheet.previewResult ? 'lg' : 'md'}
      title={
        lockSkill && selectedCatalogItem
          ? selectedCatalogItem.name
          : t('aiChat.paipanSheet.title')
      }
      footer={resultFooter}
    >
      <fieldset
        disabled={sheet.submitting}
        className="min-w-0 space-y-4 px-4 py-4 sm:px-6 sm:py-5"
      >
        {catalogLoading ? (
          <div className="flex items-center gap-2 rounded-2xl border border-hairline bg-surface-card/60 px-4 py-4 text-[13px] text-muted">
            <Loader2 size={15} className="animate-spin" />
            {t('aiChat.paipanSheet.loadingCatalog')}
          </div>
        ) : catalog.length === 0 ? (
          <div className="rounded-2xl border border-hairline bg-surface-card/60 px-4 py-4 text-[13px] text-muted">
            {t('aiChat.paipanSheet.noSystems')}
          </div>
        ) : (
          <>
            {!sheet.previewResult && !lockSkill && (
              <div className="flex items-center gap-3">
                <span className="shrink-0 text-[12px] text-muted">
                  {t('aiChat.paipanSheet.skillType')}
                </span>
                <select
                  aria-label={t('aiChat.paipanSheet.skillType')}
                  value={sheet.selectedSkill}
                  onChange={(event) =>
                    dispatchSheet({
                      type: 'selectSkill',
                      skill: event.currentTarget.value,
                    })
                  }
                  className="h-9 min-w-0 flex-1 rounded-lg border border-hairline bg-canvas px-2 text-[13px] text-ink focus:border-primary/40 focus:outline-none"
                >
                  {catalog.map((item) => (
                    <option key={item.skill} value={item.skill}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {selectedCatalogItem ? (
              <div className="space-y-4">
                {SelectedFlow ? (
                  <SelectedFlow
                    draft={sheet.draft}
                    fieldKit={PAIPAN_FLOW_FIELD_KIT}
                    helpers={PAIPAN_FLOW_HELPERS}
                    onChange={handleChange}
                    onManyChanges={handleManyChanges}
                    prefillContent={
                      CLIENT_PREFILL_SKILLS.has(selectedCatalogItem.skill) ? (
                        <ClientProfileSelector
                          selectedClientId={sheet.selectedClientId}
                          onSelect={handleSelectClient}
                          autoSelectClientId={initialClientId}
                        />
                      ) : undefined
                    }
                    finalContent={advancedContent}
                    finalAction={flowFinalAction}
                    resultContent={flowResultContent}
                  />
                ) : (
                  <>
                    <div className="rounded-2xl border border-hairline bg-surface-card/35 px-4 py-3 text-[12px] leading-5 text-muted">
                      {t('aiChat.paipanSheet.guidedFallback')}
                    </div>
                    {advancedContent}
                    {flowFinalAction}
                  </>
                )}
              </div>
            ) : null}
          </>
        )}
      </fieldset>
    </BottomSheet>
  );
}
