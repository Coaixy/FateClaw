'use client';

import { Coins, Plus, RotateCcw, X } from 'lucide-react';

import { PaipanForm } from '../shared/paipan-form';
import type {
  ChoiceGridOption,
  PaipanFlowChange,
  PaipanFlowProps,
} from '../types';
import { useI18n } from '@/lib/i18n';

type TranslateFn = ReturnType<typeof useI18n>['t'];

type YaoValue = '6' | '7' | '8' | '9';
type ManualYaoSlot = YaoValue | undefined;

const YAO_SLOT_COUNT = 6;
const EMPTY_MANUAL_YAO_SLOTS: ManualYaoSlot[] = Array.from(
  { length: YAO_SLOT_COUNT },
  () => undefined,
);
const YAO_CLICK_ORDER: YaoValue[] = ['7', '8', '9', '6'];
const YAO_DISPLAY_ORDER = [5, 4, 3, 2, 1, 0] as const;
const YAO_VALUE_TONES: Record<YaoValue, string> = {
  '6': 'border-rose-500/45 bg-rose-500/12 text-ink',
  '7': 'border-primary/45 bg-primary/12 text-ink',
  '8': 'border-hairline bg-surface-card/90 text-ink',
  '9': 'border-amber-500/50 bg-amber-500/14 text-ink',
};

function normalizeNumberSlots(
  rawSlots: unknown,
  numbers: unknown,
  method: string,
): string[] {
  const source = Array.isArray(rawSlots)
    ? rawSlots
    : Array.isArray(numbers)
      ? numbers
      : [];
  const count = method === 'three' ? 3 : Math.max(2, source.length);
  return Array.from({ length: count }, (_, index) => {
    const value = source[index];
    return typeof value === 'string'
      ? value
      : typeof value === 'number' && Number.isFinite(value)
        ? String(value)
        : '';
  });
}

function isValidNumberSlot(value: string): boolean {
  return /^[+-]?\d+$/.test(value) && Number.isInteger(Number(value));
}

function buildNumberSlotChanges(slots: string[]): PaipanFlowChange[] {
  return [
    { path: ['$numberSlots'], value: slots },
    {
      path: ['numbers'],
      // Keep empty positions in the draft; submitting a compacted list changes the cast.
      value: slots.every(isValidNumberSlot) ? slots.map(Number) : undefined,
    },
  ];
}

function NumberSlotsInput({
  slots,
  resizable,
  onChange,
}: {
  slots: string[];
  resizable: boolean;
  onChange: (slots: string[]) => void;
}) {
  const { t } = useI18n();

  return (
    <fieldset className="min-w-0 rounded-2xl border border-hairline bg-surface-card/45 p-3 sm:p-4">
      <legend className="sr-only">
        {t(
          `aiChat.paipanFlows.iching.${resizable ? 'numberList' : 'threeNumbers'}`,
        )}
      </legend>
      <p className="mb-3 text-[11px] leading-5 text-muted">
        {t(
          `aiChat.paipanFlows.iching.${resizable ? 'numberListDescription' : 'threeNumbersDescription'}`,
        )}
      </p>
      <div
        className={`grid gap-3 ${resizable ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-3'}`}
      >
        {slots.map((value, index) => {
          const label = t('aiChat.paipanFlows.iching.numberSlot', {
            index: index + 1,
          });
          const invalid = value !== '' && !isValidNumberSlot(value);
          return (
            <div key={index} className="min-w-0">
              <div className="mb-1.5 flex min-h-7 items-center justify-between gap-1">
                <span className="text-[11px] font-medium text-ink">
                  {label}
                </span>
                {resizable && slots.length > 2 && (
                  <button
                    type="button"
                    onClick={() =>
                      onChange(
                        slots.filter((_, slotIndex) => slotIndex !== index),
                      )
                    }
                    aria-label={t('aiChat.paipanFlows.iching.removeNumber', {
                      index: index + 1,
                    })}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-card hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
              <input
                type="text"
                inputMode="numeric"
                pattern="[+-]?[0-9]+"
                aria-label={label}
                aria-invalid={invalid || undefined}
                value={value}
                onChange={(event) => {
                  const nextSlots = [...slots];
                  nextSlots[index] = event.currentTarget.value.trim();
                  onChange(nextSlots);
                }}
                className="min-h-12 w-full min-w-0 rounded-xl border border-hairline bg-canvas px-2 py-2 text-center text-base text-ink tabular-nums focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/15 aria-invalid:border-error"
              />
              {invalid && (
                <p className="mt-1 text-[11px] text-error">
                  {t('aiChat.paipanFlows.iching.integerRequired')}
                </p>
              )}
            </div>
          );
        })}
      </div>
      {resizable && (
        <button
          type="button"
          onClick={() => onChange([...slots, ''])}
          className="mt-3 inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl border border-hairline bg-canvas px-3 text-[12px] font-medium text-ink hover:border-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35"
        >
          <Plus size={14} />
          {t('aiChat.paipanFlows.iching.addNumber')}
        </button>
      )}
    </fieldset>
  );
}

function buildIchingMethodOptions(t: TranslateFn): ChoiceGridOption[] {
  return [
    {
      value: 'dayan',
      label: t('aiChat.paipanFlows.iching.methods.dayan.label'),
      hint: t('aiChat.paipanFlows.iching.methods.dayan.hint'),
    },
    {
      value: 'lueshifa',
      label: t('aiChat.paipanFlows.iching.methods.lueshifa.label'),
      hint: t('aiChat.paipanFlows.iching.methods.lueshifa.hint'),
    },
    {
      value: 'time',
      label: t('aiChat.paipanFlows.iching.methods.time.label'),
      hint: t('aiChat.paipanFlows.iching.methods.time.hint'),
    },
    {
      value: 'three',
      label: t('aiChat.paipanFlows.iching.methods.three.label'),
      hint: t('aiChat.paipanFlows.iching.methods.three.hint'),
    },
    {
      value: 'array',
      label: t('aiChat.paipanFlows.iching.methods.array.label'),
      hint: t('aiChat.paipanFlows.iching.methods.array.hint'),
    },
    {
      value: 'manual',
      label: t('aiChat.paipanFlows.iching.methods.manual.label'),
      hint: t('aiChat.paipanFlows.iching.methods.manual.hint'),
    },
  ];
}

function getYaoPositionLabel(t: TranslateFn, index: number): string {
  return t(`aiChat.paipanFlows.iching.yaoPositions.${index}`);
}

function getYaoValueCopy(t: TranslateFn, value: YaoValue) {
  return {
    label: t(`aiChat.paipanFlows.iching.yaoValues.${value}.label`),
    helper: t(`aiChat.paipanFlows.iching.yaoValues.${value}.helper`),
    tone: YAO_VALUE_TONES[value],
  };
}

function normalizeYaoValue(value: unknown): ManualYaoSlot {
  return value === '6' || value === '7' || value === '8' || value === '9'
    ? value
    : undefined;
}

function normalizeManualYaoSlots(
  rawSlots: unknown,
  rawYao: string,
): ManualYaoSlot[] {
  if (Array.isArray(rawSlots)) {
    return Array.from({ length: YAO_SLOT_COUNT }, (_, index) =>
      normalizeYaoValue(rawSlots[index]),
    );
  }

  const yaoCharacters = rawYao.trim().slice(0, YAO_SLOT_COUNT).split('');
  if (yaoCharacters.length > 0) {
    return Array.from({ length: YAO_SLOT_COUNT }, (_, index) =>
      normalizeYaoValue(yaoCharacters[index]),
    );
  }

  return [...EMPTY_MANUAL_YAO_SLOTS];
}

function buildYaoStringFromSlots(slots: ManualYaoSlot[]): string | undefined {
  if (slots.length !== YAO_SLOT_COUNT || slots.some((value) => !value)) {
    return undefined;
  }
  return slots.join('');
}

function buildManualYaoChanges(slots: ManualYaoSlot[]): PaipanFlowChange[] {
  const hasAnyValue = slots.some(Boolean);
  return [
    {
      path: ['$manualYaoSlots'],
      value: hasAnyValue ? slots : undefined,
    },
    {
      path: ['yao'],
      value: buildYaoStringFromSlots(slots),
    },
  ];
}

function getNextYaoValue(current: ManualYaoSlot): YaoValue {
  if (!current) return YAO_CLICK_ORDER[0];
  const currentIndex = YAO_CLICK_ORDER.indexOf(current);
  return YAO_CLICK_ORDER[(currentIndex + 1) % YAO_CLICK_ORDER.length];
}

function rollYaoByThreeCoins(): YaoValue {
  // 三枚铜钱法等价于 3 次独立抛掷：每枚取 2 或 3，合计自然落在 6/7/8/9。
  const total = Array.from({ length: 3 }, () =>
    Math.random() < 0.5 ? 2 : 3,
  ).reduce((sum, value) => sum + value, 0);
  return String(total) as YaoValue;
}

function YaoLineGlyph({ value }: { value: ManualYaoSlot }) {
  const isYang = value === '7' || value === '9';
  const isMoving = value === '6' || value === '9';
  const lineClassName = value ? 'bg-ink/75' : 'bg-hairline/80';

  return (
    <span className="relative flex h-6 w-full max-w-[190px] items-center justify-center px-5">
      {isYang || !value ? (
        <span className={`h-2 w-full rounded-full ${lineClassName}`} />
      ) : (
        <span className="grid w-full grid-cols-[1fr_28px_1fr] items-center gap-0">
          <span className={`h-2 rounded-full ${lineClassName}`} />
          <span />
          <span className={`h-2 rounded-full ${lineClassName}`} />
        </span>
      )}
      {isMoving && (
        <span className="absolute right-0 h-2 w-2 rounded-full bg-primary shadow-[0_0_0_3px_rgba(255,255,255,0.08)]" />
      )}
    </span>
  );
}

function ManualYaoInput({
  slots,
  onChange,
}: {
  slots: ManualYaoSlot[];
  onChange: (slots: ManualYaoSlot[]) => void;
}) {
  const { t } = useI18n();
  const selectedCount = slots.filter(Boolean).length;
  // 起卦顺序固定为自下而上，因此电子摇卦总是补下一个尚未确定的爻位。
  const nextEmptyIndex = slots.findIndex((value) => !value);
  const canClear = selectedCount > 0;

  const updateSlot = (index: number, value: ManualYaoSlot) => {
    const nextSlots = [...slots];
    nextSlots[index] = value;
    onChange(nextSlots);
  };

  const rollNextYao = () => {
    if (nextEmptyIndex < 0) return;
    updateSlot(nextEmptyIndex, rollYaoByThreeCoins());
  };

  return (
    <div className="rounded-2xl border border-hairline bg-[linear-gradient(180deg,rgba(255,255,255,0.045),rgba(255,255,255,0.015))] p-3 shadow-[0_8px_24px_rgba(0,0,0,0.08)] sm:p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="mb-1.5 flex items-center gap-1">
            <span className="text-[11px] font-medium text-ink sm:text-[12px]">
              {t('aiChat.paipanFlows.iching.manualYaoTitle')}
            </span>
            <span className="text-[11px] text-rose-400">*</span>
          </div>
          <p className="text-[11px] leading-5 text-muted">
            {t('aiChat.paipanFlows.iching.manualYaoDescription')}
          </p>
        </div>

        <div className="flex gap-2 sm:shrink-0">
          <button
            type="button"
            onClick={rollNextYao}
            disabled={nextEmptyIndex < 0}
            className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-xl border border-primary/25 bg-primary/10 px-3 text-[12px] font-medium text-primary transition-colors hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 disabled:cursor-not-allowed disabled:opacity-40 sm:flex-none sm:rounded-lg"
          >
            <Coins size={14} />
            {t('aiChat.paipanFlows.iching.rollOne')}
          </button>
          <button
            type="button"
            onClick={() => onChange([...EMPTY_MANUAL_YAO_SLOTS])}
            disabled={!canClear}
            className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-xl border border-hairline bg-surface-card px-3 text-[12px] font-medium text-muted transition-colors hover:border-primary/30 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 disabled:cursor-not-allowed disabled:opacity-35 sm:flex-none sm:rounded-lg"
          >
            <RotateCcw size={14} />
            {t('aiChat.paipanFlows.iching.clear')}
          </button>
        </div>
      </div>

      <div className="mt-4 space-y-1">
        {YAO_DISPLAY_ORDER.map((slotIndex) => {
          const value = slots[slotIndex];
          const copy = value ? getYaoValueCopy(t, value) : null;
          const positionLabel = getYaoPositionLabel(t, slotIndex);
          return (
            <button
              key={`manual-yao-${slotIndex}`}
              type="button"
              onClick={() => updateSlot(slotIndex, getNextYaoValue(value))}
              className={`grid min-h-[46px] w-full grid-cols-[42px_1fr_88px] items-center gap-2 rounded-xl border px-2.5 text-left transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 focus-visible:ring-inset sm:grid-cols-[48px_1fr_104px] sm:px-3 ${
                value
                  ? 'border-primary/25 bg-surface-card/70 text-ink hover:border-primary/45'
                  : 'border-hairline bg-surface-card/45 text-muted hover:border-primary/30 hover:text-ink'
              }`}
              aria-label={t('aiChat.paipanFlows.iching.setYaoAria', {
                position: positionLabel,
                value:
                  copy?.helper ?? t('aiChat.paipanFlows.iching.undetermined'),
              })}
            >
              <span className="text-[11px] font-medium">{positionLabel}</span>
              <span className="flex min-w-0 justify-center">
                <YaoLineGlyph value={value} />
              </span>
              <span
                className={`inline-flex min-h-8 items-center justify-center rounded-lg border px-2.5 text-[12px] font-semibold ${
                  copy?.tone ?? 'border-hairline bg-canvas/25 text-muted'
                }`}
              >
                {copy?.label ?? t('aiChat.paipanFlows.iching.undetermined')}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[10px] text-muted">
        <span className="rounded-lg border border-hairline bg-canvas/25 px-2 py-1">
          {t('aiChat.paipanFlows.iching.selectedCount', {
            count: selectedCount,
          })}
        </span>
        <span className="rounded-lg border border-hairline bg-canvas/25 px-2 py-1">
          {t('aiChat.paipanFlows.iching.movingMarked')}
        </span>
      </div>
    </div>
  );
}

export function IchingFlow({
  draft,
  fieldKit,
  helpers,
  onChange,
  onManyChanges,
  finalContent,
  finalAction,
  resultContent,
}: PaipanFlowProps) {
  const { t } = useI18n();
  const { DateTimeField, ChoiceGrid } = fieldKit;
  const { getValueAtPath, getCurrentLocalDateParts, fromDateTimeLocalValue } =
    helpers;
  const method =
    typeof getValueAtPath(draft, ['method']) === 'string'
      ? String(getValueAtPath(draft, ['method']))
      : 'dayan';
  const useCurrentTime = getValueAtPath(draft, ['$useCurrentTime']) !== false;

  const yao =
    typeof getValueAtPath(draft, ['yao']) === 'string'
      ? String(getValueAtPath(draft, ['yao'])).trim()
      : '';
  const manualYaoSlots = normalizeManualYaoSlots(
    getValueAtPath(draft, ['$manualYaoSlots']),
    yao,
  );
  const numbers = getValueAtPath(draft, ['numbers']);
  const rawNumberSlots = getValueAtPath(draft, ['$numberSlots']);
  const numberSlots = normalizeNumberSlots(rawNumberSlots, numbers, method);

  const methodOptions = buildIchingMethodOptions(t);

  return (
    <PaipanForm
      finalContent={finalContent}
      finalAction={finalAction}
      resultContent={resultContent}
    >
      <ChoiceGrid
        title={t('aiChat.paipanFlows.iching.methodTitle')}
        value={method}
        options={methodOptions}
        onChange={(value) => {
          if (value === 'three' || value === 'array') {
            onManyChanges([
              { path: ['method'], value },
              ...buildNumberSlotChanges(
                normalizeNumberSlots(rawNumberSlots, numbers, value),
              ),
            ]);
            return;
          }
          onChange(['method'], value);
        }}
      />

      <ChoiceGrid
        title={t('aiChat.paipanFlows.iching.timeTitle')}
        value={useCurrentTime ? 'now' : 'custom'}
        options={[
          {
            value: 'now',
            label: t('aiChat.paipanFlows.common.currentTimeSolar'),
            hint: t('aiChat.paipanFlows.common.nowRecommended'),
          },
          {
            value: 'custom',
            label: t('aiChat.paipanFlows.common.customTimeSolar'),
            hint: t('aiChat.paipanFlows.iching.customTimeHint'),
          },
        ]}
        onChange={(value) => {
          if (value === 'now') {
            onManyChanges([
              { path: ['$useCurrentTime'], value: true },
              { path: ['datetime'], value: undefined },
            ]);
            return;
          }
          const now = getCurrentLocalDateParts();
          onManyChanges([
            { path: ['$useCurrentTime'], value: false },
            {
              path: ['datetime'],
              value:
                typeof getValueAtPath(draft, ['datetime']) === 'string'
                  ? getValueAtPath(draft, ['datetime'])
                  : fromDateTimeLocalValue(now.dateTime),
            },
          ]);
        }}
      />

      {!useCurrentTime && (
        <DateTimeField
          title={t('aiChat.paipanFlows.iching.customTimeField')}
          required
          description={t('aiChat.paipanFlows.iching.customTimeDescription')}
          value={getValueAtPath(draft, ['datetime'])}
          onChange={(value) => onChange(['datetime'], value)}
        />
      )}

      {method === 'three' || method === 'array' || method === 'manual' ? (
        <>
          {(method === 'three' || method === 'array') && (
            <NumberSlotsInput
              slots={numberSlots}
              resizable={method === 'array'}
              onChange={(slots) => onManyChanges(buildNumberSlotChanges(slots))}
            />
          )}

          {method === 'manual' && (
            <ManualYaoInput
              slots={manualYaoSlots}
              onChange={(slots) => onManyChanges(buildManualYaoChanges(slots))}
            />
          )}
        </>
      ) : null}
    </PaipanForm>
  );
}
