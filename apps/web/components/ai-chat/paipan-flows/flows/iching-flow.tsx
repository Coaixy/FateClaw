'use client';

import { PaipanStepFrame } from '../shared/paipan-step-frame';
import { PaipanStepper, type PaipanStep } from '../shared/paipan-stepper';
import type { ChoiceGridOption, PaipanFlowProps } from '../types';

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
  { value: 'manual', label: '手动输入六爻', hint: '适合已经知道卦象的人' },
];

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
      description: '只有数字起卦或手动输入卦象时需要填写。',
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
              <FieldTextInput
                title="六爻卦象"
                required
                description="从下往上输入 6 位数字，每位只能是 6、7、8、9。"
                value={
                  typeof getValueAtPath(draft, ['yao']) === 'string'
                    ? String(getValueAtPath(draft, ['yao']))
                    : ''
                }
                placeholder="例如 789678"
                onChange={(value) => onChange(['yao'], value)}
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
    />
  );
}
