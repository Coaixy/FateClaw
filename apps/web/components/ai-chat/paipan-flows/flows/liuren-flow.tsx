'use client';

import { Shuffle } from 'lucide-react';
import { PaipanStepFrame } from '../shared/paipan-step-frame';
import { PaipanStepper, type PaipanStep } from '../shared/paipan-stepper';
import type { PaipanFlowProps } from '../types';

const LIUREN_RANDOM_SHICHEN_START_HOURS = [
  23, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21,
];

function getRandomLiurenShichenHour(randomNumber?: number): number {
  // 填数字时做稳定映射，方便用户复盘；不填时才真随机抽一个今日时辰。
  const index =
    typeof randomNumber === 'number' && !Number.isNaN(randomNumber)
      ? Math.abs(Math.trunc(randomNumber)) % LIUREN_RANDOM_SHICHEN_START_HOURS.length
      : Math.floor(Math.random() * LIUREN_RANDOM_SHICHEN_START_HOURS.length);
  return LIUREN_RANDOM_SHICHEN_START_HOURS[index];
}

function normalizeRandomNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function formatLiurenShichen(hour: unknown): string {
  if (typeof hour !== 'number' || Number.isNaN(hour)) return '未抽取';
  const labels = ['子', '丑', '丑', '寅', '寅', '卯', '卯', '辰', '辰', '巳', '巳', '午', '午', '未', '未', '申', '申', '酉', '酉', '戌', '戌', '亥', '亥', '子'];
  return `${labels[hour] ?? '-'}时 ${String(hour).padStart(2, '0')}:00`;
}

/**
 * 大六壬排盘的新手引导填写 flow。
 *
 * @param props 外层弹窗注入的 draft、字段组件、辅助函数和变更回调。
 * @returns 分步骤填写当前时间、随机时辰或指定时刻的大六壬排盘表单。
 */
export function LiurenFlow({
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
  const { DateField, TimeField, ChoiceGrid, FieldTextInput } = fieldKit;
  const { getValueAtPath, getCurrentLocalDateParts } = helpers;
  const useCurrentTime = getValueAtPath(draft, ['$useCurrentTime']) !== false;
  const timeMode =
    typeof getValueAtPath(draft, ['$liurenTimeMode']) === 'string'
      ? String(getValueAtPath(draft, ['$liurenTimeMode']))
      : useCurrentTime
        ? 'now'
        : 'custom';
  const randomNumber =
    typeof getValueAtPath(draft, ['randomNumber']) === 'number'
      ? Number(getValueAtPath(draft, ['randomNumber']))
      : undefined;
  const selectedHour = getValueAtPath(draft, ['hour']);
  const startDate =
    typeof getValueAtPath(draft, ['solarDate']) === 'string'
      ? String(getValueAtPath(draft, ['solarDate']))
      : '';
  const hasStartHour = typeof getValueAtPath(draft, ['hour']) === 'number';

  const steps: PaipanStep[] = [
    {
      id: 'time-mode',
      title: '起课时间（公历）',
      description: '新手直接用当前公历时间；也可以随机抽今日时辰，或指定一个确切时刻。',
      status: useCurrentTime ? 'complete' : 'optional',
      content: (
        <PaipanStepFrame title="起课时间（公历）">
          <ChoiceGrid
            title="起课时间（公历）"
            value={timeMode}
            columns={3}
            options={[
              {
                value: 'now',
                label: '当前时间（公历）',
                hint: '适合直接起课',
                recommended: true,
              },
              {
                value: 'random',
                label: '随机时辰（今日）',
                hint: '可填数字固定随机结果',
              },
              {
                value: 'custom',
                label: '指定时间（公历）',
                hint: '复盘某个时刻时使用',
              },
            ]}
            onChange={(value) => {
              if (value === 'now') {
                onManyChanges([
                  { path: ['$liurenTimeMode'], value: 'now' },
                  { path: ['timeMode'], value: undefined },
                  { path: ['$useCurrentTime'], value: true },
                  { path: ['solarDate'], value: undefined },
                  { path: ['hour'], value: undefined },
                  { path: ['minute'], value: undefined },
                  { path: ['randomNumber'], value: undefined },
                ]);
                return;
              }
              const now = getCurrentLocalDateParts();
              if (value === 'random') {
                onManyChanges([
                  { path: ['$liurenTimeMode'], value: 'random' },
                  { path: ['timeMode'], value: 'random' },
                  { path: ['$useCurrentTime'], value: false },
                  { path: ['solarDate'], value: now.date },
                  {
                    path: ['hour'],
                    value: getRandomLiurenShichenHour(randomNumber),
                  },
                  { path: ['minute'], value: 0 },
                ]);
                return;
              }
              onManyChanges([
                { path: ['$liurenTimeMode'], value: 'custom' },
                { path: ['timeMode'], value: 'custom' },
                { path: ['$useCurrentTime'], value: false },
                { path: ['randomNumber'], value: undefined },
                {
                  path: ['solarDate'],
                  value:
                    typeof getValueAtPath(draft, ['solarDate']) === 'string'
                      ? getValueAtPath(draft, ['solarDate'])
                      : now.date,
                },
                {
                  path: ['hour'],
                  value:
                    typeof getValueAtPath(draft, ['hour']) === 'number'
                      ? getValueAtPath(draft, ['hour'])
                      : now.hour,
                },
                {
                  path: ['minute'],
                  value:
                    typeof getValueAtPath(draft, ['minute']) === 'number'
                      ? getValueAtPath(draft, ['minute'])
                      : now.minute,
                },
              ]);
            }}
          />

          {timeMode === 'random' && (
            <div className="space-y-3">
              <FieldTextInput
                title="随机数字"
                description="可不填；填写后会稳定映射到今日 12 个时辰之一。"
                value={randomNumber === undefined ? '' : String(randomNumber)}
                placeholder="例如 8848"
                onChange={(value) => {
                  const now = getCurrentLocalDateParts();
                  const nextRandomNumber = normalizeRandomNumber(value);
                  onManyChanges([
                    { path: ['randomNumber'], value: nextRandomNumber },
                    { path: ['timeMode'], value: 'random' },
                    { path: ['solarDate'], value: now.date },
                    {
                      path: ['hour'],
                      value: getRandomLiurenShichenHour(nextRandomNumber),
                    },
                    { path: ['minute'], value: 0 },
                  ]);
                }}
              />
              <div className="flex flex-col gap-2 rounded-xl border border-hairline bg-surface-card px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="text-[11px] font-medium text-muted">
                    已抽取时辰
                  </div>
                  <div className="mt-1 text-[14px] font-semibold text-ink">
                    {startDate || getCurrentLocalDateParts().date} · {formatLiurenShichen(selectedHour)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const now = getCurrentLocalDateParts();
                    onManyChanges([
                      { path: ['randomNumber'], value: undefined },
                      { path: ['timeMode'], value: 'random' },
                      { path: ['solarDate'], value: now.date },
                      { path: ['hour'], value: getRandomLiurenShichenHour() },
                      { path: ['minute'], value: 0 },
                    ]);
                  }}
                  className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl border border-primary/25 bg-primary/10 px-3 text-[12px] font-medium text-primary transition-colors hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 sm:rounded-lg"
                >
                  <Shuffle size={14} />
                  重抽时辰
                </button>
              </div>
            </div>
          )}
        </PaipanStepFrame>
      ),
    },
    {
      id: 'custom-time',
      title: '指定时刻（公历）',
      description:
        timeMode === 'random'
          ? '已抽取今日时辰；需要时也可以在这里微调日期和时间。'
          : '只有选择“指定时间（公历）”时需要填写。',
      status: startDate && hasStartHour ? 'complete' : 'incomplete',
      content: useCurrentTime ? null : (
        <PaipanStepFrame title="指定时刻（公历）">
          <DateField
            title="起课日期（公历）"
            required
            value={startDate}
            onChange={(value) => onChange(['solarDate'], value)}
          />

          <TimeField
            title="起课时间（公历）"
            required
            hour={getValueAtPath(draft, ['hour'])}
            minute={getValueAtPath(draft, ['minute'])}
            onChange={(next) =>
              onManyChanges([
                { path: ['hour'], value: next.hour },
                { path: ['minute'], value: next.minute ?? 0 },
              ])
            }
          />
        </PaipanStepFrame>
      ),
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
