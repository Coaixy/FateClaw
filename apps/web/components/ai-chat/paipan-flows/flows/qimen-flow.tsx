'use client';

import { PaipanForm } from '../shared/paipan-form';
import type { PaipanFlowProps } from '../types';
import { useI18n } from '@/lib/i18n';

const QIMEN_RANDOM_SHICHEN_START_HOURS = [
  23, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21,
];

function getRandomQimenShichenHour(): number {
  // 奇门这里抽的是“时辰”，用每个时辰的起始整点代表该时段，分钟固定为 0。
  return QIMEN_RANDOM_SHICHEN_START_HOURS[
    Math.floor(Math.random() * QIMEN_RANDOM_SHICHEN_START_HOURS.length)
  ];
}

export function QimenFlow({
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
  const { DateField, TimeField, ChoiceGrid } = fieldKit;
  const { getValueAtPath, getCurrentLocalDateParts } = helpers;
  const useCurrentTime = getValueAtPath(draft, ['$useCurrentTime']) !== false;
  const timeMode =
    typeof getValueAtPath(draft, ['$qimenTimeMode']) === 'string'
      ? String(getValueAtPath(draft, ['$qimenTimeMode']))
      : useCurrentTime
        ? 'now'
        : 'custom';
  const startDate =
    typeof getValueAtPath(draft, ['solarDate']) === 'string'
      ? String(getValueAtPath(draft, ['solarDate']))
      : '';

  return (
    <PaipanForm
      finalContent={finalContent}
      finalAction={finalAction}
      resultContent={resultContent}
    >
      <ChoiceGrid
        title={t('aiChat.paipanFlows.qimen.panTypeTitle')}
        value={String(getValueAtPath(draft, ['panType']) ?? '转盘')}
        options={[
          { value: '转盘', label: t('aiChat.paipanFlows.qimen.rotating') },
          { value: '鸣法', label: t('aiChat.paipanFlows.qimen.mingfa') },
        ]}
        onChange={(value) => onChange(['panType'], value)}
      />
      <ChoiceGrid
        title={t('aiChat.paipanFlows.qimen.timeTitle')}
        value={timeMode}
        options={[
          {
            value: 'now',
            label: t('aiChat.paipanFlows.common.currentTimeSolar'),
            hint: t('aiChat.paipanFlows.qimen.nowHint'),
          },
          {
            value: 'random',
            label: t('aiChat.paipanFlows.qimen.randomToday'),
            hint: t('aiChat.paipanFlows.qimen.randomHint'),
          },
          {
            value: 'custom',
            label: t('aiChat.paipanFlows.common.customTimeSolar'),
            hint: t('aiChat.paipanFlows.qimen.customHint'),
          },
        ]}
        onChange={(value) => {
          if (value === 'now') {
            onManyChanges([
              { path: ['$qimenTimeMode'], value: 'now' },
              { path: ['$useCurrentTime'], value: true },
              { path: ['solarDate'], value: undefined },
              { path: ['hour'], value: undefined },
              { path: ['minute'], value: undefined },
            ]);
            return;
          }
          const now = getCurrentLocalDateParts();
          if (value === 'random') {
            onManyChanges([
              { path: ['$qimenTimeMode'], value: 'random' },
              { path: ['$useCurrentTime'], value: false },
              { path: ['solarDate'], value: now.date },
              { path: ['hour'], value: getRandomQimenShichenHour() },
              { path: ['minute'], value: 0 },
            ]);
            return;
          }
          onManyChanges([
            { path: ['$qimenTimeMode'], value: 'custom' },
            { path: ['$useCurrentTime'], value: false },
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

      {!useCurrentTime && (
        <>
          <DateField
            title={t('aiChat.paipanFlows.qimen.dateTitle')}
            required
            value={startDate}
            onChange={(value) => onChange(['solarDate'], value)}
          />

          <TimeField
            title={t('aiChat.paipanFlows.qimen.timeFieldTitle')}
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
        </>
      )}
    </PaipanForm>
  );
}
