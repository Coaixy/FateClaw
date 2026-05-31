'use client';

import { PaipanStepFrame } from '../shared/paipan-step-frame';
import { PaipanStepper, type PaipanStep } from '../shared/paipan-stepper';
import type { PaipanFlowProps } from '../types';

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
}: PaipanFlowProps) {
  const { DateField, TimeField, ChoiceGrid } = fieldKit;
  const { getValueAtPath, getCurrentLocalDateParts } = helpers;
  const useCurrentTime = getValueAtPath(draft, ['$useCurrentTime']) !== false;
  const startDate =
    typeof getValueAtPath(draft, ['solarDate']) === 'string'
      ? String(getValueAtPath(draft, ['solarDate']))
      : '';
  const hasStartHour = typeof getValueAtPath(draft, ['hour']) === 'number';

  const steps: PaipanStep[] = [
    {
      id: 'time-mode',
      title: '起盘时间（公历）',
      description: '新手直接用当前公历时间即可；回看某个时刻再指定公历时间。',
      status: useCurrentTime ? 'complete' : 'optional',
      content: (
        <PaipanStepFrame title="起盘时间（公历）">
          <ChoiceGrid
            title="起盘时间（公历）"
            value={useCurrentTime ? 'now' : 'custom'}
            options={[
              {
                value: 'now',
                label: '当前时间（公历）',
                hint: '最省事，适合直接起局',
                recommended: true,
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
                  { path: ['$useCurrentTime'], value: true },
                  { path: ['solarDate'], value: undefined },
                  { path: ['hour'], value: undefined },
                  { path: ['minute'], value: undefined },
                ]);
                return;
              }
              const now = getCurrentLocalDateParts();
              onManyChanges([
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
      description: '只有选择“指定时间（公历）”时需要填写。',
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
    />
  );
}
