'use client';

import { Shuffle } from 'lucide-react';
import { PaipanStepFrame } from '../shared/paipan-step-frame';
import { PaipanStepper, type PaipanStep } from '../shared/paipan-stepper';
import type { PaipanFlowProps } from '../types';
import { useI18n } from '@/lib/i18n';

type TranslateFn = ReturnType<typeof useI18n>['t'];

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

function formatLiurenShichen(hour: unknown, t: TranslateFn): string {
  if (typeof hour !== 'number' || Number.isNaN(hour)) {
    return t('aiChat.paipanFlows.liuren.notDrawn');
  }
  const labels = ['子', '丑', '丑', '寅', '寅', '卯', '卯', '辰', '辰', '巳', '巳', '午', '午', '未', '未', '申', '申', '酉', '酉', '戌', '戌', '亥', '亥', '子'];
  return t('aiChat.paipanFlows.liuren.shichenFormat', {
    branch: labels[hour] ?? '-',
    hour: String(hour).padStart(2, '0'),
  });
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
  const { t } = useI18n();
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
      title: t('aiChat.paipanFlows.liuren.timeTitle'),
      description: t('aiChat.paipanFlows.liuren.timeDescription'),
      status: useCurrentTime ? 'complete' : 'optional',
      content: (
        <PaipanStepFrame title={t('aiChat.paipanFlows.liuren.timeTitle')}>
          <ChoiceGrid
            title={t('aiChat.paipanFlows.liuren.timeTitle')}
            value={timeMode}
            columns={3}
            options={[
              {
                value: 'now',
                label: t('aiChat.paipanFlows.common.currentTimeSolar'),
                hint: t('aiChat.paipanFlows.liuren.nowHint'),
                recommended: true,
              },
              {
                value: 'random',
                label: t('aiChat.paipanFlows.liuren.randomToday'),
                hint: t('aiChat.paipanFlows.liuren.randomHint'),
              },
              {
                value: 'custom',
                label: t('aiChat.paipanFlows.common.customTimeSolar'),
                hint: t('aiChat.paipanFlows.liuren.customHint'),
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
                title={t('aiChat.paipanFlows.liuren.randomNumber')}
                description={t('aiChat.paipanFlows.liuren.randomNumberDescription')}
                value={randomNumber === undefined ? '' : String(randomNumber)}
                placeholder={t('aiChat.paipanFlows.liuren.randomNumberPlaceholder')}
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
                    {t('aiChat.paipanFlows.liuren.selectedShichen')}
                  </div>
                  <div className="mt-1 text-[14px] font-semibold text-ink">
                    {startDate || getCurrentLocalDateParts().date} · {formatLiurenShichen(selectedHour, t)}
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
                  {t('aiChat.paipanFlows.liuren.reroll')}
                </button>
              </div>
            </div>
          )}
        </PaipanStepFrame>
      ),
    },
    {
      id: 'custom-time',
      title: t('aiChat.paipanFlows.liuren.customTitle'),
      description:
        timeMode === 'random'
          ? t('aiChat.paipanFlows.liuren.customRandomDescription')
          : t('aiChat.paipanFlows.liuren.customDescription'),
      status: startDate && hasStartHour ? 'complete' : 'incomplete',
      content: useCurrentTime ? null : (
        <PaipanStepFrame title={t('aiChat.paipanFlows.liuren.customTitle')}>
          <DateField
            title={t('aiChat.paipanFlows.liuren.dateTitle')}
            required
            value={startDate}
            onChange={(value) => onChange(['solarDate'], value)}
          />

          <TimeField
            title={t('aiChat.paipanFlows.liuren.timeFieldTitle')}
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
