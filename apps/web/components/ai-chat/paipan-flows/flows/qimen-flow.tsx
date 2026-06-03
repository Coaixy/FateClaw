'use client';

import { PaipanStepFrame } from '../shared/paipan-step-frame';
import { PaipanStepper, type PaipanStep } from '../shared/paipan-stepper';
import type { PaipanFlowProps } from '../types';

const QIMEN_RANDOM_SHICHEN_START_HOURS = [
  23, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21,
];

function getRandomQimenShichenHour(): number {
  // 奇门这里抽的是“时辰”，用每个时辰的起始整点代表该时段，分钟固定为 0。
  return QIMEN_RANDOM_SHICHEN_START_HOURS[
    Math.floor(Math.random() * QIMEN_RANDOM_SHICHEN_START_HOURS.length)
  ];
}

/**
 * 奇门遁甲排盘的新手引导填写 flow。
 *
 * @param props 外层弹窗注入的 draft、字段组件、辅助函数和变更回调。
 * @returns 分步骤填写当前时间或指定起盘时间的奇门排盘表单。
 */
export function QimenFlow({
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
  const hasStartHour = typeof getValueAtPath(draft, ['hour']) === 'number';

  const steps: PaipanStep[] = [
    {
      id: 'time-mode',
      title: '起盘时间（公历）',
      description: '新手直接用当前公历时间即可；想随机取今日时辰或回看某个时刻时再切换。',
      status: useCurrentTime ? 'complete' : 'optional',
      content: (
        <PaipanStepFrame title="起盘时间（公历）">
          <ChoiceGrid
            title="起盘时间（公历）"
            value={timeMode}
            columns={3}
            options={[
              {
                value: 'now',
                label: '当前时间（公历）',
                hint: '最省事，适合直接起局',
                recommended: true,
              },
              {
                value: 'random',
                label: '随机时辰（今日）',
                hint: '在今天 12 个时辰里随机抽一个',
              },
              {
                value: 'custom',
                label: '指定时间（公历）',
                hint: '想回看某个时刻再选这个',
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
        </PaipanStepFrame>
      ),
    },
    {
      id: 'custom-time',
      title: '指定时刻（公历）',
      description:
        timeMode === 'random'
          ? '已随机抽取今日时辰；需要时也可以在这里微调。'
          : '只有选择“指定时间（公历）”时需要填写。',
      status: startDate && hasStartHour ? 'complete' : 'incomplete',
      content: useCurrentTime ? null : (
        <PaipanStepFrame title="指定时刻（公历）">
          <DateField
            title="起盘日期（公历）"
            required
            value={startDate}
            onChange={(value) => onChange(['solarDate'], value)}
          />

          <TimeField
            title="起盘时间（公历）"
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
