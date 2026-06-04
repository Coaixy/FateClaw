'use client';

import { PaipanStepFrame } from '../shared/paipan-step-frame';
import { PaipanStepper, type PaipanStep } from '../shared/paipan-stepper';
import type { ChoiceGridOption, PaipanFlowProps } from '../types';

const MEIHUA_METHOD_OPTIONS: ChoiceGridOption[] = [
  {
    value: 'time',
    label: '时间起卦',
    hint: '按当前或指定公历时间起卦',
    recommended: true,
  },
  {
    value: 'counts',
    label: '数值起卦',
    hint: '报数、字数、外应等统一换算为数字',
  },
  {
    value: 'trigrams',
    label: '指定上下卦',
    hint: '已经知道上下卦和动爻时使用',
  },
];

const COUNT_METHOD_OPTIONS: ChoiceGridOption[] = [
  { value: 'number', label: '报数', hint: '直接输入数字', recommended: true },
  { value: 'word', label: '字数', hint: '姓名、字句等换算' },
  { value: 'sound', label: '声音', hint: '声数或响动' },
  { value: 'object', label: '物数', hint: '物件数量' },
  { value: 'direction', label: '方位', hint: '方位外应取数' },
  { value: 'external', label: '外应', hint: '其他外应取数' },
];

const TRIGRAM_OPTIONS: ChoiceGridOption[] = [
  { value: '乾', label: '乾', hint: '天 · 金' },
  { value: '兑', label: '兑', hint: '泽 · 金' },
  { value: '离', label: '离', hint: '火 · 火' },
  { value: '震', label: '震', hint: '雷 · 木' },
  { value: '巽', label: '巽', hint: '风 · 木' },
  { value: '坎', label: '坎', hint: '水 · 水' },
  { value: '艮', label: '艮', hint: '山 · 土' },
  { value: '坤', label: '坤', hint: '地 · 土' },
];

const MOVING_LINE_OPTIONS: ChoiceGridOption[] = [
  { value: '1', label: '初爻', hint: '第一爻' },
  { value: '2', label: '二爻', hint: '第二爻' },
  { value: '3', label: '三爻', hint: '第三爻' },
  { value: '4', label: '四爻', hint: '第四爻' },
  { value: '5', label: '五爻', hint: '第五爻' },
  { value: '6', label: '上爻', hint: '第六爻' },
];

function formatIntegerValue(value: unknown): string {
  return typeof value === 'number' && Number.isInteger(value)
    ? String(value)
    : '';
}

function parseIntegerValue(value: string | undefined): number | undefined {
  const normalized = value?.trim();
  if (!normalized || !/^-?\d+$/.test(normalized)) return undefined;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function normalizeMovingLineValue(value: unknown): string | undefined {
  return typeof value === 'number' && value >= 1 && value <= 6
    ? String(value)
    : undefined;
}

function isValidCountNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * 梅花易数排盘的新手引导填写 flow。
 *
 * @param props 外层弹窗注入的 draft、字段组件、辅助函数和变更回调。
 * @returns 分步骤填写时间起卦、数值起卦或指定上下卦参数的排盘表单。
 */
export function MeihuaFlow({
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
  const { DateTimeField, ChoiceGrid, FieldTextInput } = fieldKit;
  const { getValueAtPath, getCurrentLocalDateParts, fromDateTimeLocalValue } =
    helpers;
  const method =
    typeof getValueAtPath(draft, ['method']) === 'string'
      ? String(getValueAtPath(draft, ['method']))
      : 'time';
  const useCurrentTime = getValueAtPath(draft, ['$useCurrentTime']) !== false;
  const datetime =
    typeof getValueAtPath(draft, ['datetime']) === 'string'
      ? String(getValueAtPath(draft, ['datetime'])).trim()
      : '';
  const upper = getValueAtPath(draft, ['upper']);
  const lower = getValueAtPath(draft, ['lower']);
  const moving = getValueAtPath(draft, ['moving']);
  const upperTrigram = getValueAtPath(draft, ['upperTrigram']);
  const lowerTrigram = getValueAtPath(draft, ['lowerTrigram']);
  const movingLineValue = normalizeMovingLineValue(
    getValueAtPath(draft, ['movingLine']),
  );
  const countMethod =
    typeof getValueAtPath(draft, ['countMethod']) === 'string'
      ? String(getValueAtPath(draft, ['countMethod']))
      : 'number';
  const label =
    typeof getValueAtPath(draft, ['label']) === 'string'
      ? String(getValueAtPath(draft, ['label']))
      : '';
  const hasValidTime = useCurrentTime || Boolean(datetime);
  const hasValidCounts =
    isValidCountNumber(upper) &&
    isValidCountNumber(lower) &&
    (moving === undefined || isValidCountNumber(moving));
  const hasValidTrigrams =
    typeof upperTrigram === 'string' &&
    typeof lowerTrigram === 'string' &&
    Boolean(movingLineValue);

  const steps: PaipanStep[] = [
    {
      id: 'method',
      title: '起卦方式',
      description: '不确定时使用当前时间起卦。',
      status: method ? 'complete' : 'incomplete',
      content: (
        <PaipanStepFrame title="起卦方式">
          <ChoiceGrid
            title="起卦方式"
            value={method}
            options={MEIHUA_METHOD_OPTIONS}
            onChange={(value) => onChange(['method'], value)}
          />
        </PaipanStepFrame>
      ),
    },
    {
      id: 'time',
      title: '起卦时间（公历）',
      description: '当前时间适合现场起卦；复盘旧事时可指定公历时刻。',
      status: hasValidTime ? 'complete' : 'incomplete',
      content:
        method === 'time' ? (
          <PaipanStepFrame title="起卦时间（公历）">
            <ChoiceGrid
              title="起卦时间（公历）"
              value={useCurrentTime ? 'now' : 'custom'}
              options={[
                {
                  value: 'now',
                  label: '当前时间（公历）',
                  hint: '按提交时刻起卦',
                  recommended: true,
                },
                {
                  value: 'custom',
                  label: '指定时间（公历）',
                  hint: '手动选择年月日时',
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
                value={getValueAtPath(draft, ['datetime'])}
                onChange={(value) => onChange(['datetime'], value)}
              />
            )}
          </PaipanStepFrame>
        ) : null,
    },
    {
      id: 'counts',
      title: '数值参数',
      description: '上卦、下卦和动爻按梅花取数规则自动取余。',
      status: hasValidCounts ? 'complete' : 'incomplete',
      content:
        method === 'counts' ? (
          <PaipanStepFrame title="数值起卦">
            <ChoiceGrid
              title="取数来源"
              value={countMethod}
              options={COUNT_METHOD_OPTIONS}
              columns={3}
              onChange={(value) => onChange(['countMethod'], value)}
            />
            <div className="grid gap-3 sm:grid-cols-3">
              <FieldTextInput
                title="上卦取数"
                required
                value={formatIntegerValue(upper)}
                placeholder="例如 9"
                onChange={(value) =>
                  onChange(['upper'], parseIntegerValue(value))
                }
              />
              <FieldTextInput
                title="下卦取数"
                required
                value={formatIntegerValue(lower)}
                placeholder="例如 10"
                onChange={(value) =>
                  onChange(['lower'], parseIntegerValue(value))
                }
              />
              <FieldTextInput
                title="动爻取数"
                value={formatIntegerValue(moving)}
                placeholder="可不填"
                onChange={(value) =>
                  onChange(['moving'], parseIntegerValue(value))
                }
              />
            </div>
            <FieldTextInput
              title="备注"
              value={label}
              placeholder="例如 原始报数 9、10、10"
              onChange={(value) => onChange(['label'], value)}
            />
          </PaipanStepFrame>
        ) : null,
    },
    {
      id: 'trigrams',
      title: '上下卦与动爻',
      description: '适合已经有明确卦象，只需要生成梅花盘面时使用。',
      status: hasValidTrigrams ? 'complete' : 'incomplete',
      content:
        method === 'trigrams' ? (
          <PaipanStepFrame title="指定上下卦">
            <ChoiceGrid
              title="上卦"
              required
              value={
                typeof upperTrigram === 'string' ? upperTrigram : undefined
              }
              options={TRIGRAM_OPTIONS}
              onChange={(value) => onChange(['upperTrigram'], value)}
            />
            <ChoiceGrid
              title="下卦"
              required
              value={
                typeof lowerTrigram === 'string' ? lowerTrigram : undefined
              }
              options={TRIGRAM_OPTIONS}
              onChange={(value) => onChange(['lowerTrigram'], value)}
            />
            <ChoiceGrid
              title="动爻"
              required
              value={movingLineValue}
              options={MOVING_LINE_OPTIONS}
              columns={3}
              onChange={(value) =>
                onChange(['movingLine'], Number.parseInt(value, 10))
              }
            />
            <FieldTextInput
              title="备注"
              value={label}
              placeholder="例如 乾上兑下四爻动"
              onChange={(value) => onChange(['label'], value)}
            />
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
