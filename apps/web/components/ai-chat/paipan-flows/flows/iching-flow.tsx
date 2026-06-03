'use client';

import { Coins, RotateCcw } from 'lucide-react';

import { PaipanStepFrame } from '../shared/paipan-step-frame';
import { PaipanStepper, type PaipanStep } from '../shared/paipan-stepper';
import type { ChoiceGridOption, PaipanFlowChange, PaipanFlowProps } from '../types';

const ICHING_METHOD_OPTIONS: ChoiceGridOption[] = [
  {
    value: 'dayan',
    label: '大衍筮法',
    hint: '以古法大衍流程起卦',
    recommended: true,
  },
  { value: 'lueshifa', label: '略筮法', hint: '以简化筮法快速起卦' },
  { value: 'time', label: '时间起卦（公历）', hint: '用当前公历时间或指定公历时间' },
  { value: 'three', label: '三数起卦', hint: '输入 3 个数字' },
  { value: 'array', label: '数字起卦', hint: '输入 2 个以上数字' },
  {
    value: 'manual',
    label: '手动 / 电子摇卦',
    hint: '点选六爻，或按三枚铜钱法逐爻摇出',
  },
];

type YaoValue = '6' | '7' | '8' | '9';
type ManualYaoSlot = YaoValue | undefined;

const YAO_SLOT_COUNT = 6;
const EMPTY_MANUAL_YAO_SLOTS: ManualYaoSlot[] = Array.from(
  { length: YAO_SLOT_COUNT },
  () => undefined,
);
const YAO_CLICK_ORDER: YaoValue[] = ['7', '8', '9', '6'];
const YAO_DISPLAY_ORDER = [5, 4, 3, 2, 1, 0] as const;
const YAO_POSITION_LABELS = ['初爻', '二爻', '三爻', '四爻', '五爻', '上爻'] as const;
const YAO_VALUE_COPY: Record<
  YaoValue,
  {
    label: string;
    tone: string;
    helper: string;
  }
> = {
  '6': {
    label: '老阴·动',
    tone: 'border-rose-500/45 bg-rose-500/12 text-ink',
    helper: '老阴动爻',
  },
  '7': {
    label: '少阳',
    tone: 'border-primary/45 bg-primary/12 text-ink',
    helper: '少阳静爻',
  },
  '8': {
    label: '少阴',
    tone: 'border-hairline bg-surface-card/90 text-ink',
    helper: '少阴静爻',
  },
  '9': {
    label: '老阳·动',
    tone: 'border-amber-500/50 bg-amber-500/14 text-ink',
    helper: '老阳动爻',
  },
};

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
  const total = Array.from({ length: 3 }, () => (Math.random() < 0.5 ? 2 : 3))
    .reduce((sum, value) => sum + value, 0);
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
              六爻卦象
            </span>
            <span className="text-[11px] text-rose-400">*</span>
          </div>
          <p className="text-[11px] leading-5 text-muted">
            从下往上确定初爻至上爻；点击爻位可切换类型。
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
            摇一爻
          </button>
          <button
            type="button"
            onClick={() => onChange([...EMPTY_MANUAL_YAO_SLOTS])}
            disabled={!canClear}
            className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-xl border border-hairline bg-surface-card px-3 text-[12px] font-medium text-muted transition-colors hover:border-primary/30 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 disabled:cursor-not-allowed disabled:opacity-35 sm:flex-none sm:rounded-lg"
          >
            <RotateCcw size={14} />
            清空
          </button>
        </div>
      </div>

      <div className="mt-4 space-y-1">
        {YAO_DISPLAY_ORDER.map((slotIndex) => {
          const value = slots[slotIndex];
          const copy = value ? YAO_VALUE_COPY[value] : null;
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
              aria-label={`设置${YAO_POSITION_LABELS[slotIndex]}，当前为${copy?.helper ?? '未定'}`}
            >
              <span className="text-[11px] font-medium">
                {YAO_POSITION_LABELS[slotIndex]}
              </span>
              <span className="flex min-w-0 justify-center">
                <YaoLineGlyph value={value} />
              </span>
              <span
                className={`inline-flex min-h-8 items-center justify-center rounded-lg border px-2.5 text-[12px] font-semibold ${
                  copy?.tone ?? 'border-hairline bg-canvas/25 text-muted'
                }`}
              >
                {copy?.label ?? '未定'}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[10px] text-muted">
        <span className="rounded-lg border border-hairline bg-canvas/25 px-2 py-1">
          已定 {selectedCount}/6
        </span>
        <span className="rounded-lg border border-hairline bg-canvas/25 px-2 py-1">
          动爻以圆点标记
        </span>
      </div>
    </div>
  );
}

/**
 * 六爻排盘的新手引导填写 flow。
 *
 * @param props 外层弹窗注入的 draft、字段组件、辅助函数和变更回调。
 * @returns 分步骤填写起卦方式、起卦时间和条件参数的排盘表单。
 */
export function IchingFlow({
  draft,
  fieldKit,
  helpers,
  onChange,
  onManyChanges,
  finalContent,
  finalAction,
  resultContent,
  resultAction,
  onResultStepChange,
}: PaipanFlowProps) {
  const {
    DateTimeField,
    ChoiceGrid,
    FieldTextInput,
  } = fieldKit;
  const {
    getValueAtPath,
    getCurrentLocalDateParts,
    fromDateTimeLocalValue,
    formatArrayInputValue,
    parseDelimitedArrayInput,
  } = helpers;
  const method =
    typeof getValueAtPath(draft, ['method']) === 'string'
      ? String(getValueAtPath(draft, ['method']))
      : 'dayan';
  const useCurrentTime = getValueAtPath(draft, ['$useCurrentTime']) !== false;
  const datetime =
    typeof getValueAtPath(draft, ['datetime']) === 'string'
      ? String(getValueAtPath(draft, ['datetime'])).trim()
      : '';
  const yao =
    typeof getValueAtPath(draft, ['yao']) === 'string'
      ? String(getValueAtPath(draft, ['yao'])).trim()
      : '';
  const manualYaoSlots = normalizeManualYaoSlots(
    getValueAtPath(draft, ['$manualYaoSlots']),
    yao,
  );
  const numbers = getValueAtPath(draft, ['numbers']);
  const hasValidMethodParams =
    method === 'manual'
      ? /^[6789]{6}$/.test(yao)
      : method === 'three'
        ? Array.isArray(numbers) &&
          numbers.length === 3 &&
          numbers.every((value) => typeof value === 'number' && !Number.isNaN(value))
        : method === 'array'
          ? Array.isArray(numbers) &&
            numbers.length >= 2 &&
            numbers.every((value) => typeof value === 'number' && !Number.isNaN(value))
          : true;

  const steps: PaipanStep[] = [
    {
      id: 'method',
      title: '起卦方式',
      description: '不确定时使用推荐的大衍筮法。',
      status: method ? 'complete' : 'incomplete',
      content: (
        <PaipanStepFrame title="起卦方式">
          <ChoiceGrid
            title="起卦方式"
            value={method}
            options={ICHING_METHOD_OPTIONS}
            onChange={(value) => onChange(['method'], value)}
          />
        </PaipanStepFrame>
      ),
    },
    {
      id: 'time',
      title: '起卦时间（公历）',
      description: '直接起卦选当前公历时间；复盘某个时刻再指定公历时间。',
      status: useCurrentTime || datetime ? 'complete' : 'incomplete',
      content: (
        <PaipanStepFrame title="起卦时间（公历）">
          <ChoiceGrid
            title="起卦时间（公历）"
            value={useCurrentTime ? 'now' : 'custom'}
            options={[
              {
                value: 'now',
                label: '当前时间（公历）',
                hint: '适合直接起卦',
                recommended: true,
              },
              {
                value: 'custom',
                label: '指定时间（公历）',
                hint: '手动六爻和数字起卦也能指定时刻',
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
              title="指定起卦时刻（公历）"
              required
              description="无论是手动六爻、数字起卦还是按时间起卦，都可以指定这里的公历时刻。"
              value={getValueAtPath(draft, ['datetime'])}
              onChange={(value) => onChange(['datetime'], value)}
            />
          )}
        </PaipanStepFrame>
      ),
    },
    {
      id: 'method-params',
      title: '补充参数',
      description: '只有数字起卦或手动 / 电子摇卦时需要填写。',
      status: hasValidMethodParams ? 'complete' : 'incomplete',
      content:
        method === 'three' || method === 'array' || method === 'manual' ? (
          <PaipanStepFrame title="补充参数">
            {(method === 'three' || method === 'array') && (
              <FieldTextInput
                title={method === 'three' ? '三个数字' : '数字列表'}
                required
                description={
                  method === 'three'
                    ? '请输入 3 个数字，多个数字用逗号分隔。'
                    : '请输入 2 个以上数字，多个数字用逗号分隔。'
                }
                value={formatArrayInputValue(getValueAtPath(draft, ['numbers']))}
                placeholder={method === 'three' ? '例如 3, 8, 5' : '例如 7, 2, 9, 4'}
                onChange={(value) =>
                  onChange(
                    ['numbers'],
                    parseDelimitedArrayInput(value ?? '', 'integer'),
                  )
                }
              />
            )}

            {method === 'manual' && (
              <ManualYaoInput
                slots={manualYaoSlots}
                onChange={(slots) => onManyChanges(buildManualYaoChanges(slots))}
              />
            )}
          </PaipanStepFrame>
        ) : null,
    },
  ];

  return (
    <PaipanStepper
      steps={steps}
      finalContent={finalContent}
      finalAction={finalAction}
      resultContent={resultContent}
      resultAction={resultAction}
      onResultStepChange={onResultStepChange}
    />
  );
}
