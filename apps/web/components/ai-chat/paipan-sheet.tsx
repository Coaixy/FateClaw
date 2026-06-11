'use client';

import { type ReactNode, useEffect, useMemo, useState } from 'react';
import {
  CalendarDays,
  ChevronDown,
  Clock3,
  Loader2,
  MessageCircle,
  Sparkles,
} from 'lucide-react';

import { ArtifactRenderer } from '@/components/chat/artifact-renderer';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { Button } from '@/components/ui/button';
import {
  resolvePaipanFlow,
  type PaipanFlowFieldKit,
} from '@/components/ai-chat/paipan-flows';
import {
  PAIPAN_FLOW_HELPERS,
  PAIPAN_SHEET_HELPERS,
} from '@/components/ai-chat/paipan-sheet-helpers';
import {
  type PaipanCatalogItem,
  type PaipanCommitResponse,
  type PaipanPreviewResponse,
  type PaipanSchema,
  paipanApi,
} from '@/features/paipan/api';
import { useToast } from '@/lib/use-toast';

type PaipanSheetMode = 'pre-chat' | 'current-session';

interface PaipanSheetProps {
  open: boolean;
  mode: PaipanSheetMode;
  catalog: PaipanCatalogItem[];
  catalogLoading: boolean;
  sessionId?: string;
  initialSkill?: string | null;
  lockSkill?: boolean;
  canCommit?: boolean;
  onClose: () => void;
  onAuthRequired?: () => void;
  onCommitted: (result: PaipanCommitResponse) => Promise<void> | void;
}

const {
  buildDateTimePickerValue,
  buildDateValue,
  buildInitialDraftForSkill,
  buildSubmitInputForSkill,
  clampNumber,
  formatArrayInputValue,
  getCurrentLocalDateParts,
  getDaysInMonth,
  getFieldCopy,
  getOptionLabel,
  getPrimaryType,
  getSimpleHiddenFieldPaths,
  getValueAtPath,
  hasVisibleSchemaFields,
  isValidInteger,
  pad2,
  parseDateTimePickerValue,
  parseDateValue,
  parseDelimitedArrayInput,
  setValueAtPath,
  validateDraftForSkill,
} = PAIPAN_SHEET_HELPERS;

const PAIPAN_FLOW_FIELD_KIT: PaipanFlowFieldKit = {
  DateField,
  TimeField,
  DateTimeField,
  ChoiceGrid,
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
      <span className="text-[11px] sm:text-[12px] font-medium text-ink">{title}</span>
      {required && <span className="text-[11px] text-rose-400">*</span>}
    </div>
  );
}

function FieldCard({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-hairline bg-[linear-gradient(180deg,rgba(255,255,255,0.045),rgba(255,255,255,0.015))] p-3 shadow-[0_8px_24px_rgba(0,0,0,0.08)] sm:p-4">
      {children}
    </div>
  );
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
    <FieldCard>
      <FieldLabel title={title} required={required} />
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value.trim() || undefined)}
        placeholder={placeholder}
        className="min-h-10 w-full rounded-xl border border-hairline bg-surface-card px-3 py-2 text-[13px] text-ink placeholder:text-muted/60 focus:border-primary/40 focus:outline-none"
      />
      <PropertyDescription text={description} />
    </FieldCard>
  );
}

const MONTH_OPTIONS = Array.from({ length: 12 }, (_, index) => index + 1);
const SHICHEN_LABELS = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];

type PaipanDateTimePickerMode = 'date' | 'time' | 'datetime';

type PaipanDateTimePickerValue = {
  date?: string;
  hour?: unknown;
  minute?: unknown;
};

function PickerShellButton({
  active,
  children,
  className = '',
  onClick,
}: {
  active?: boolean;
  children: ReactNode;
  className?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`min-h-9 rounded-xl border px-2.5 text-[12px] transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-inset ${
        active
          ? 'border-primary bg-primary/12 text-ink shadow-[0_6px_14px_rgba(0,0,0,0.08)]'
          : 'border-hairline bg-surface-card/55 text-muted hover:border-primary/35 hover:text-ink'
      } ${className}`}
    >
      {children}
    </button>
  );
}

function getShichenLabel(hour: number): string {
  return SHICHEN_LABELS[Math.floor(((hour + 1) % 24) / 2)] ?? '';
}

function CompactPickerNumberInput({
  label,
  value,
  min,
  max,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  const [draftValue, setDraftValue] = useState(String(value));
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) {
      setDraftValue(String(value));
    }
  }, [editing, value]);

  const commitDraftValue = (rawValue: string) => {
    const next = Number.parseInt(rawValue, 10);
    if (Number.isNaN(next)) {
      setDraftValue(String(value));
      return;
    }

    // 输入过程中不打断用户，提交时再统一限制到合法范围。
    const normalized = clampNumber(next, min, max);
    setDraftValue(String(normalized));
    if (normalized !== value) {
      onChange(normalized);
    }
  };

  const moveCaretToEnd = (input: HTMLInputElement) => {
    window.requestAnimationFrame(() => {
      input.setSelectionRange(input.value.length, input.value.length);
    });
  };

  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-[10px] text-muted">{label}</span>
      <span className="relative block">
        <input
          type="text"
          inputMode="numeric"
          value={draftValue}
          onFocus={(event) => {
            setEditing(true);
            moveCaretToEnd(event.currentTarget);
          }}
          onMouseUp={(event) => {
            event.preventDefault();
            moveCaretToEnd(event.currentTarget);
          }}
          onBlur={(event) => {
            setEditing(false);
            commitDraftValue(event.currentTarget.value);
          }}
          onChange={(event) => {
            setDraftValue(event.currentTarget.value.replace(/\D/g, ''));
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur();
            }
          }}
          className="h-9 w-full rounded-lg border border-hairline bg-surface-card px-2.5 pr-8 text-[12px] text-ink focus:border-primary/45 focus:outline-none"
        />
        {suffix && (
          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-muted">
            {suffix}
          </span>
        )}
      </span>
    </label>
  );
}

function CompactPickerMonthGrid({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="min-w-0">
      <span className="mb-1 block text-[10px] text-muted">月份</span>
      <div
        role="radiogroup"
        aria-label="月份"
        className="grid grid-cols-4 gap-1.5"
      >
        {MONTH_OPTIONS.map((month) => {
          const active = month === value;
          return (
            <button
              key={`paipan-month-${month}`}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(month)}
              className={`min-h-11 rounded-lg border px-2 text-[12px] font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-inset ${
                active
                  ? 'border-primary bg-primary/12 text-ink shadow-[0_6px_14px_rgba(0,0,0,0.08)]'
                  : 'border-hairline bg-surface-card/55 text-muted hover:border-primary/35 hover:text-ink'
              }`}
            >
              {month} 月
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PaipanDateTimePicker({
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
  value: PaipanDateTimePickerValue;
  mode: PaipanDateTimePickerMode;
  onChange: (value: { date?: string; hour?: number; minute?: number }) => void;
}) {
  const now = getCurrentLocalDateParts();
  const selectedDateParts = parseDateValue(value.date);
  const fallbackDateParts = parseDateValue(now.date) ?? {
    year: new Date().getFullYear(),
    month: new Date().getMonth() + 1,
    day: new Date().getDate(),
  };
  const dateParts = selectedDateParts ?? fallbackDateParts;
  const showDate = mode === 'date' || mode === 'datetime';
  const showTime = mode === 'time' || mode === 'datetime';
  const selectedHour = isValidInteger(value.hour)
    ? clampNumber(value.hour, 0, 23)
    : undefined;
  const selectedMinute = isValidInteger(value.minute)
    ? clampNumber(value.minute, 0, 59)
    : undefined;
  const displayHour = selectedHour ?? now.hour;
  const displayMinute = selectedMinute ?? 0;
  const selectedDate = typeof value.date === 'string' ? value.date : '';
  const selectedTimeLabel =
    selectedHour === undefined ? '请选择时间' : `${pad2(selectedHour)}:${pad2(selectedMinute ?? 0)}`;
  const selectedDateLabel = selectedDate ? `${selectedDate}（公历）` : '请选择公历日期';
  const selectedMonthDays = getDaysInMonth(dateParts.year, dateParts.month);
  const [pickerOpen, setPickerOpen] = useState(false);

  const commitDate = (year: number, month: number, day: number) => {
    const nextDate = buildDateValue(year, month, day);
    onChange({
      date: nextDate,
      hour: showTime ? displayHour : selectedHour,
      minute: showTime ? displayMinute : selectedMinute,
    });
  };

  const commitTime = (hour: number, minute: number) => {
    onChange({
      date: showDate ? selectedDate || buildDateValue(dateParts.year, dateParts.month, dateParts.day) : selectedDate,
      hour: clampNumber(hour, 0, 23),
      minute: clampNumber(minute, 0, 59),
    });
  };

  const commitCurrentMoment = () => {
    onChange({
      date: showDate ? now.date : selectedDate,
      hour: showTime ? now.hour : selectedHour,
      minute: showTime ? now.minute : selectedMinute,
    });
  };

  return (
    <>
      <FieldCard>
        <FieldLabel title={title} required={required} />
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="flex min-h-10 w-full items-center justify-between gap-2 rounded-xl border border-hairline bg-surface-card/70 px-3 py-2 text-left transition-all duration-150 hover:border-primary/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-inset"
        >
          <span className="flex min-w-0 flex-wrap gap-1.5">
            {showDate && (
              <span className="inline-flex min-h-7 items-center gap-1 rounded-lg border border-hairline bg-canvas/25 px-2 text-[11px] text-ink">
                <CalendarDays size={12} className="shrink-0 text-primary" />
                <span>{selectedDateLabel}</span>
              </span>
            )}
            {showTime && (
              <span className="inline-flex min-h-7 items-center gap-1 rounded-lg border border-hairline bg-canvas/25 px-2 text-[11px] text-ink">
                <Clock3 size={12} className="shrink-0 text-primary" />
                <span>{selectedTimeLabel}</span>
              </span>
            )}
          </span>
          <span className="shrink-0 rounded-md bg-primary/10 px-2 py-1 text-[10px] font-medium text-primary">
            选择
          </span>
        </button>
        <PropertyDescription text={description} />
      </FieldCard>

      <BottomSheet
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        variant="sheet"
        size="sm"
        zIndex={140}
        title={title}
        footer={
          <div className="flex gap-2 px-3 py-2.5 sm:justify-end sm:px-6">
            <button
              type="button"
              onClick={commitCurrentMoment}
              className="h-8 flex-1 rounded-lg border border-primary/20 bg-primary/10 px-3 text-[12px] font-medium text-primary transition-colors hover:bg-primary/15 sm:flex-none"
            >
              {mode === 'date' ? '今天' : '现在'}
            </button>
            <button
              type="button"
              onClick={() => setPickerOpen(false)}
              className="h-8 flex-1 rounded-lg bg-primary px-3 text-[12px] font-medium text-on-primary transition-colors hover:bg-primary-active sm:flex-none"
            >
              完成
            </button>
          </div>
        }
      >
        <div className="space-y-3 px-3 py-3 sm:px-5 sm:py-4">
          <div className="flex flex-wrap gap-1.5 rounded-xl border border-hairline bg-surface-card/45 p-1.5">
            {showDate && (
              <span className="inline-flex min-h-7 items-center gap-1 rounded-lg bg-canvas/25 px-2 text-[11px] text-ink">
                <CalendarDays size={12} className="text-primary" />
                {selectedDateLabel}
              </span>
            )}
            {showTime && (
              <span className="inline-flex min-h-7 items-center gap-1 rounded-lg bg-canvas/25 px-2 text-[11px] text-ink">
                <Clock3 size={12} className="text-primary" />
                {selectedTimeLabel}
              </span>
            )}
          </div>

          {showDate && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <CompactPickerNumberInput
                  label="年份"
                  value={dateParts.year}
                  min={1900}
                  max={2100}
                  suffix="年"
                  onChange={(year) => commitDate(year, dateParts.month, dateParts.day)}
                />

                <CompactPickerNumberInput
                  label="日期"
                  value={dateParts.day}
                  min={1}
                  max={selectedMonthDays}
                  suffix="日"
                  onChange={(day) => commitDate(dateParts.year, dateParts.month, day)}
                />
              </div>

              <CompactPickerMonthGrid
                value={dateParts.month}
                onChange={(month) => commitDate(dateParts.year, month, dateParts.day)}
              />
            </div>
          )}

          {showTime && (
            <div className={showDate ? 'space-y-3 border-t border-hairline pt-4' : 'space-y-3'}>
              <div className="grid grid-cols-2 gap-2">
                <CompactPickerNumberInput
                  label="小时"
                  value={displayHour}
                  min={0}
                  max={23}
                  suffix={getShichenLabel(displayHour)}
                  onChange={(hour) => commitTime(hour, displayMinute)}
                />

                <CompactPickerNumberInput
                  label="分钟"
                  value={displayMinute}
                  min={0}
                  max={59}
                  suffix="分"
                  onChange={(minute) => commitTime(displayHour, minute)}
                />
              </div>

              <div className="grid grid-cols-[44px_1fr_44px] gap-1.5">
                <PickerShellButton
                  className="min-h-9 rounded-lg px-0"
                  onClick={() => commitTime(displayHour, displayMinute - 1)}
                >
                  -1
                </PickerShellButton>
                <div className="flex min-h-9 items-center justify-center rounded-lg border border-hairline bg-surface-card/45 px-2 text-[12px] text-ink">
                  {pad2(displayHour)}:{pad2(displayMinute)}
                </div>
                <PickerShellButton
                  className="min-h-9 rounded-lg px-0"
                  onClick={() => commitTime(displayHour, displayMinute + 1)}
                >
                  +1
                </PickerShellButton>
              </div>
            </div>
          )}
        </div>
      </BottomSheet>
    </>
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
    <PaipanDateTimePicker
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
    <PaipanDateTimePicker
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
    <PaipanDateTimePicker
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
  columns = 2,
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
    recommended?: boolean;
  }>;
  columns?: 2 | 3;
  onChange: (value: string) => void;
}) {
  return (
    <FieldCard>
      <FieldLabel title={title} required={required} />
      <div
        className={`mt-2.5 grid gap-1.5 sm:gap-2 ${
          columns === 3 ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-2'
        }`}
      >
        {options.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={`${title}-${option.value}`}
              type="button"
              onClick={() => onChange(option.value)}
              className={`min-h-[58px] rounded-xl border px-2.5 py-2.5 text-left transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-inset sm:min-h-[64px] sm:px-3 ${
                active
                  ? 'border-primary bg-primary/10 text-ink shadow-[0_8px_18px_rgba(0,0,0,0.08)]'
                  : 'border-hairline bg-surface-card/55 text-muted hover:border-primary/30 hover:text-ink'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] sm:text-[12px] font-medium">{option.label}</span>
                {option.recommended && (
                  <span className="rounded-full bg-primary/12 px-1.5 py-0.5 text-[9px] text-primary">
                    推荐
                  </span>
                )}
              </div>
              {option.hint && (
                <p className="mt-1 text-[9px] leading-4 text-muted">
                  {option.hint}
                </p>
              )}
            </button>
          );
        })}
      </div>
      <PropertyDescription text={description} />
    </FieldCard>
  );
}

function SchemaFields({
  schema,
  draft,
  pathPrefix = [],
  hiddenPaths,
  onChange,
}: {
  schema?: PaipanSchema;
  draft: Record<string, unknown>;
  pathPrefix?: string[];
  hiddenPaths: Set<string>;
  onChange: (path: string[], value: unknown) => void;
}) {
  if (!schema) return null;

  const visibleEntries = Object.entries(schema.properties).filter(([key, property]) => {
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
  });

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
        const copy = getFieldCopy(fieldPathKey, key, property.description);

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
                onChange={(event) => onChange(path, event.currentTarget.checked)}
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
                  const label = getOptionLabel(fieldPathKey, option);
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
                <option value="">请选择</option>
                {property.enum.map((option) => (
                  <option
                    key={`${fieldPathKey}-${String(option)}`}
                    value={String(option)}
                  >
                    {getOptionLabel(fieldPathKey, option)}
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
                placeholder={copy.placeholder ?? '多个值用逗号分隔'}
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
                    type === 'integer'
                      ? Number.parseInt(raw, 10)
                      : Number(raw),
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

export function PaipanSheet({
  open,
  mode,
  catalog,
  catalogLoading,
  sessionId,
  initialSkill,
  lockSkill = false,
  canCommit = true,
  onClose,
  onAuthRequired,
  onCommitted,
}: PaipanSheetProps) {
  const { toast } = useToast();
  const [selectedSkill, setSelectedSkill] = useState('');
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [previewResult, setPreviewResult] = useState<PaipanPreviewResponse | null>(null);
  const [previewSkillName, setPreviewSkillName] = useState('');
  const [resultStepActive, setResultStepActive] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const selectedCatalogItem = useMemo(
    () => catalog.find((item) => item.skill === selectedSkill) ?? null,
    [catalog, selectedSkill],
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
    () =>
      hasVisibleSchemaFields(selectedCatalogItem?.parameters, hiddenPaths),
    [hiddenPaths, selectedCatalogItem],
  );

  useEffect(() => {
    if (!open) {
      return;
    }

    if (catalog.length === 0) {
      setSelectedSkill('');
      return;
    }

    setSelectedSkill((current) => {
      if (initialSkill && catalog.some((item) => item.skill === initialSkill)) {
        return initialSkill;
      }
      if (current && catalog.some((item) => item.skill === current)) {
        return current;
      }
      return catalog[0]?.skill ?? '';
    });
  }, [catalog, initialSkill, open]);

  useEffect(() => {
    if (!selectedCatalogItem) {
      setDraft({});
      setResultStepActive(false);
      return;
    }
    // 每次切换术数时重建一份更适合普通用户的初始表单状态。
    setDraft(buildInitialDraftForSkill(selectedCatalogItem.skill, selectedCatalogItem.parameters));
    setPreviewResult(null);
    setPreviewSkillName('');
    setResultStepActive(false);
    setAdvancedOpen(false);
  }, [selectedCatalogItem]);

  useEffect(() => {
    if (!open) {
      setSelectedSkill('');
      setPreviewResult(null);
      setPreviewSkillName('');
      setResultStepActive(false);
      setSubmitting(false);
      setAdvancedOpen(false);
    }
  }, [open]);

  const resetPreviewState = () => {
    setPreviewResult(null);
    setPreviewSkillName('');
    setResultStepActive(false);
  };

  const handleChange = (path: string[], value: unknown) => {
    resetPreviewState();
    setDraft((previous) => setValueAtPath(previous, path, value));
  };

  const handleManyChanges = (changes: Array<{ path: string[]; value: unknown }>) => {
    resetPreviewState();
    setDraft((previous) =>
      changes.reduce(
        (nextDraft, change) => setValueAtPath(nextDraft, change.path, change.value),
        previous,
      ),
    );
  };

  const buildCurrentSubmitInput = (): Record<string, unknown> | null => {
    if (!selectedCatalogItem) {
      return null;
    }

    const validationError = validateDraftForSkill(selectedCatalogItem.skill, draft);
    if (validationError) {
      toast('error', validationError);
      return null;
    }

    return buildSubmitInputForSkill(selectedCatalogItem.skill, draft);
  };

  const handlePreview = async () => {
    if (!selectedCatalogItem) {
      toast('error', '请先选择排盘类型');
      return;
    }

    const submitInput = buildCurrentSubmitInput();
    if (!submitInput) {
      return;
    }

    setSubmitting(true);
    try {
      const result = await paipanApi.preview({
        skill: selectedCatalogItem.skill,
        input: submitInput,
      });
      setPreviewResult(result);
      setPreviewSkillName(selectedCatalogItem.name);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : '排盘预览失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCommitIntoCurrentSession = async () => {
    if (!canCommit) {
      onAuthRequired?.();
      return;
    }

    if (!selectedCatalogItem || !sessionId) {
      toast('error', '当前会话不存在');
      return;
    }

    const submitInput = buildCurrentSubmitInput();
    if (!submitInput) {
      return;
    }

    setSubmitting(true);
    try {
      const result = await paipanApi.commit({
        target: 'current_session',
        sessionId,
        skill: selectedCatalogItem.skill,
        input: submitInput,
      });
      await onCommitted(result);
      onClose();
    } catch (error) {
      toast('error', error instanceof Error ? error.message : '插入盘面失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleStartChatFromPreview = async () => {
    if (!canCommit) {
      onAuthRequired?.();
      return;
    }

    if (!previewResult) {
      toast('error', '请先完成排盘预览');
      return;
    }
    setSubmitting(true);
    try {
      const result = await paipanApi.commit({
        target: 'new_session_from_preview',
        previewId: previewResult.previewId,
      });
      await onCommitted(result);
      onClose();
    } catch (error) {
      toast('error', error instanceof Error ? error.message : '创建排盘会话失败');
    } finally {
      setSubmitting(false);
    }
  };

  const flowFinalAction =
    <Button
      onClick={() => void handlePreview()}
      loading={submitting}
      icon={<Sparkles size={14} />}
      className="h-9 w-full rounded-xl text-[12px] sm:w-auto sm:rounded-lg"
    >
      生成盘面预览
    </Button>;
  const flowResultAction =
    mode === 'pre-chat' ? (
      <Button
        onClick={() => void handleStartChatFromPreview()}
        loading={submitting}
        icon={<MessageCircle size={14} />}
        className="h-9 w-full rounded-xl text-[12px] sm:w-auto sm:rounded-lg"
      >
        {canCommit ? '基于此盘开始对话' : '登录后开始对话'}
      </Button>
    ) : (
      <Button
        onClick={() => void handleCommitIntoCurrentSession()}
        loading={submitting}
        icon={<Sparkles size={14} />}
        className="h-9 w-full rounded-xl text-[12px] sm:w-auto sm:rounded-lg"
      >
        {canCommit ? '插入到当前对话' : '登录后插入对话'}
      </Button>
    );
  const flowResultContent = previewResult ? (
    <div className="rounded-[24px] border border-hairline bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.015))] p-2 sm:p-3">
      <ArtifactRenderer
        fitViewportHeight
        entries={[
          {
            skill: previewResult.skillContextEntry.skill,
            output: previewResult.skillContextEntry.output,
            artifactType: previewResult.skillContextEntry.artifactType,
            artifactTitle: previewResult.skillContextEntry.artifactTitle,
            artifactData: previewResult.skillContextEntry.artifactData,
          },
        ]}
      />
    </div>
  ) : null;
  // 结果页主动作固定在弹层底部；只保留按钮，把垂直空间让给盘面本身。
  const resultFooter = previewResult && resultStepActive ? (
    <div className="px-4 py-3 sm:px-6">
      <div className="w-full shrink-0 sm:ml-auto sm:w-auto">
        {flowResultAction}
      </div>
    </div>
  ) : null;

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      variant="fullscreen-sheet"
      size="lg"
      title="手动排盘"
      titleExtra={
        <span className="rounded-full border border-hairline bg-surface-card/70 px-2.5 py-1 text-[10px] text-muted">
          {mode === 'pre-chat' ? '可选入口' : '当前会话'}
        </span>
      }
      footer={resultFooter}
    >
      <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-5">
        {catalogLoading ? (
          <div className="flex items-center gap-2 rounded-2xl border border-hairline bg-surface-card/60 px-4 py-4 text-[13px] text-muted">
            <Loader2 size={15} className="animate-spin" />
            正在加载可用排盘类型...
          </div>
        ) : catalog.length === 0 ? (
          <div className="rounded-2xl border border-hairline bg-surface-card/60 px-4 py-4 text-[13px] text-muted">
            当前没有可用的系统排盘。
          </div>
        ) : (
          <>
            {!resultStepActive &&
              (lockSkill && selectedCatalogItem ? (
                <div className="rounded-[24px] border border-hairline bg-surface-card/45 px-4 py-4">
                  <p className="text-[11px] font-medium tracking-[0.08em] text-muted">
                    已选术数
                  </p>
                  <div className="mt-2 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[14px] sm:text-[15px] font-semibold tracking-tight text-ink">
                        {selectedCatalogItem.name}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 text-[10px] font-medium text-primary">
                      快捷入口
                    </span>
                  </div>
                </div>
              ) : (
                <div>
                  <FieldLabel title="排盘类型" required />
                  <select
                    value={selectedSkill}
                    onChange={(event) =>
                      setSelectedSkill(event.currentTarget.value)
                    }
                    className="w-full rounded-2xl border border-hairline bg-surface-card px-3 py-2.5 text-[13px] text-ink focus:border-primary/40 focus:outline-none"
                  >
                    {catalog.map((item) => (
                      <option key={item.skill} value={item.skill}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </div>
              ))}

            {selectedCatalogItem ? (
              <div className="space-y-4">
                {SelectedFlow ? (
                  <SelectedFlow
                    draft={draft}
                    fieldKit={PAIPAN_FLOW_FIELD_KIT}
                    helpers={PAIPAN_FLOW_HELPERS}
                    onChange={handleChange}
                    onManyChanges={handleManyChanges}
                    finalAction={flowFinalAction}
                    resultContent={flowResultContent}
                    onResultStepChange={setResultStepActive}
                  />
                ) : (
                  <div className="rounded-2xl border border-hairline bg-surface-card/35 px-4 py-3 text-[12px] leading-5 text-muted">
                    当前术数暂未配置引导式填写，请使用下方高级设置填写参数。
                  </div>
                )}

                {hasAdvancedFields && (
                  <div className="rounded-[26px] border border-hairline bg-surface-card/35">
                    <button
                      type="button"
                      onClick={() => setAdvancedOpen((previous) => !previous)}
                      className="flex min-h-[60px] w-full items-center justify-between gap-3 px-4 py-4 text-left"
                    >
                      <div>
                        <p className="text-[12px] sm:text-[13px] font-medium text-ink">
                          高级设置
                        </p>
                        <p className="mt-1 text-[11px] leading-5 text-muted">
                          一般不用填，只有你明确知道自己要改什么时再展开。
                        </p>
                      </div>
                      <ChevronDown
                        size={18}
                        className={`shrink-0 text-muted transition-transform duration-200 ${
                          advancedOpen ? 'rotate-180' : ''
                        }`}
                      />
                    </button>

                    {advancedOpen && (
                      <div className="border-t border-hairline px-4 py-4">
                        <SchemaFields
                          schema={selectedCatalogItem.parameters}
                          draft={draft}
                          hiddenPaths={hiddenPaths}
                          onChange={handleChange}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : null}
          </>
        )}
      </div>
    </BottomSheet>
  );
}
