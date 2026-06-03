'use client';

import { PaipanStepFrame } from '../shared/paipan-step-frame';
import { PaipanStepper, type PaipanStep } from '../shared/paipan-stepper';
import type { PaipanFlowProps } from '../types';

/**
 * 八字排盘的新手引导填写 flow。
 *
 * @param props 外层弹窗注入的 draft、字段组件、辅助函数和变更回调。
 * @returns 分步骤填写出生日期、出生时间和性别的排盘表单。
 */
export function BaziFlow({
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
  const { getValueAtPath, normalizeGenderValue } = helpers;
  const gender = normalizeGenderValue(getValueAtPath(draft, ['gender']));
  const birthDate =
    typeof getValueAtPath(draft, ['solarDate']) === 'string'
      ? String(getValueAtPath(draft, ['solarDate']))
      : '';
  const hasBirthHour = typeof getValueAtPath(draft, ['hour']) === 'number';

  const steps: PaipanStep[] = [
    {
      id: 'birth-date',
      title: '出生日期（公历）',
      description: '先确认公历出生日期，这是排盘最基础的信息。',
      status: birthDate ? 'complete' : 'incomplete',
      content: (
        <PaipanStepFrame title="出生日期（公历）">
          <DateField
            title="出生日期（公历）"
            required
            value={birthDate}
            onChange={(value) => onChange(['solarDate'], value)}
          />
        </PaipanStepFrame>
      ),
    },
    {
      id: 'birth-time',
      title: '出生时间（公历）',
      description: '按公历出生日期对应的时间填写；只知道大概时段时，先选最接近的整点。',
      status: hasBirthHour ? 'complete' : 'incomplete',
      content: (
        <PaipanStepFrame title="出生时间（公历）">
          <TimeField
            title="出生时间（公历）"
            required
            description="按公历出生日期对应的时间填写；只知道大概时段时，先选最接近的整点即可。"
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
    {
      id: 'gender',
      title: '性别',
      description: '用于起运和部分排盘规则。',
      status: gender ? 'complete' : 'incomplete',
      content: (
        <PaipanStepFrame title="性别">
          <ChoiceGrid
            title="性别"
            required
            value={gender}
            options={[
              { value: '男', label: '男' },
              { value: '女', label: '女' },
            ]}
            onChange={(value) => onChange(['gender'], value)}
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
