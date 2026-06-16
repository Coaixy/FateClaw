'use client';

import { PaipanStepFrame } from '../shared/paipan-step-frame';
import { PaipanStepper, type PaipanStep } from '../shared/paipan-stepper';
import type { ChoiceGridOption, PaipanFlowProps } from '../types';
import { useI18n } from '@/lib/i18n';

type TranslateFn = ReturnType<typeof useI18n>['t'];

function buildMeihuaMethodOptions(t: TranslateFn): ChoiceGridOption[] {
  return [
    {
      value: 'time',
      label: t('aiChat.paipanFlows.meihua.methods.time.label'),
      hint: t('aiChat.paipanFlows.meihua.methods.time.hint'),
      recommended: true,
    },
    {
      value: 'counts',
      label: t('aiChat.paipanFlows.meihua.methods.counts.label'),
      hint: t('aiChat.paipanFlows.meihua.methods.counts.hint'),
    },
    {
      value: 'trigrams',
      label: t('aiChat.paipanFlows.meihua.methods.trigrams.label'),
      hint: t('aiChat.paipanFlows.meihua.methods.trigrams.hint'),
    },
  ];
}

function buildCountMethodOptions(t: TranslateFn): ChoiceGridOption[] {
  return [
    {
      value: 'number',
      label: t('aiChat.paipanFlows.meihua.countMethods.number.label'),
      hint: t('aiChat.paipanFlows.meihua.countMethods.number.hint'),
      recommended: true,
    },
    {
      value: 'word',
      label: t('aiChat.paipanFlows.meihua.countMethods.word.label'),
      hint: t('aiChat.paipanFlows.meihua.countMethods.word.hint'),
    },
    {
      value: 'sound',
      label: t('aiChat.paipanFlows.meihua.countMethods.sound.label'),
      hint: t('aiChat.paipanFlows.meihua.countMethods.sound.hint'),
    },
    {
      value: 'object',
      label: t('aiChat.paipanFlows.meihua.countMethods.object.label'),
      hint: t('aiChat.paipanFlows.meihua.countMethods.object.hint'),
    },
    {
      value: 'direction',
      label: t('aiChat.paipanFlows.meihua.countMethods.direction.label'),
      hint: t('aiChat.paipanFlows.meihua.countMethods.direction.hint'),
    },
    {
      value: 'external',
      label: t('aiChat.paipanFlows.meihua.countMethods.external.label'),
      hint: t('aiChat.paipanFlows.meihua.countMethods.external.hint'),
    },
  ];
}

function buildTrigramOptions(t: TranslateFn): ChoiceGridOption[] {
  return [
    {
      value: '乾',
      label: t('aiChat.paipanFlows.meihua.trigrams.qian.label'),
      hint: t('aiChat.paipanFlows.meihua.trigrams.qian.hint'),
    },
    {
      value: '兑',
      label: t('aiChat.paipanFlows.meihua.trigrams.dui.label'),
      hint: t('aiChat.paipanFlows.meihua.trigrams.dui.hint'),
    },
    {
      value: '离',
      label: t('aiChat.paipanFlows.meihua.trigrams.li.label'),
      hint: t('aiChat.paipanFlows.meihua.trigrams.li.hint'),
    },
    {
      value: '震',
      label: t('aiChat.paipanFlows.meihua.trigrams.zhen.label'),
      hint: t('aiChat.paipanFlows.meihua.trigrams.zhen.hint'),
    },
    {
      value: '巽',
      label: t('aiChat.paipanFlows.meihua.trigrams.xun.label'),
      hint: t('aiChat.paipanFlows.meihua.trigrams.xun.hint'),
    },
    {
      value: '坎',
      label: t('aiChat.paipanFlows.meihua.trigrams.kan.label'),
      hint: t('aiChat.paipanFlows.meihua.trigrams.kan.hint'),
    },
    {
      value: '艮',
      label: t('aiChat.paipanFlows.meihua.trigrams.gen.label'),
      hint: t('aiChat.paipanFlows.meihua.trigrams.gen.hint'),
    },
    {
      value: '坤',
      label: t('aiChat.paipanFlows.meihua.trigrams.kun.label'),
      hint: t('aiChat.paipanFlows.meihua.trigrams.kun.hint'),
    },
  ];
}

function buildMovingLineOptions(t: TranslateFn): ChoiceGridOption[] {
  return ['1', '2', '3', '4', '5', '6'].map((value) => ({
    value,
    label: t(`aiChat.paipanFlows.meihua.movingLines.${value}.label`),
    hint: t(`aiChat.paipanFlows.meihua.movingLines.${value}.hint`),
  }));
}

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
  const { t } = useI18n();
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
  const methodOptions = buildMeihuaMethodOptions(t);
  const countMethodOptions = buildCountMethodOptions(t);
  const trigramOptions = buildTrigramOptions(t);
  const movingLineOptions = buildMovingLineOptions(t);

  const steps: PaipanStep[] = [
    {
      id: 'method',
      title: t('aiChat.paipanFlows.meihua.methodTitle'),
      description: t('aiChat.paipanFlows.meihua.methodDescription'),
      status: method ? 'complete' : 'incomplete',
      content: (
        <PaipanStepFrame title={t('aiChat.paipanFlows.meihua.methodTitle')}>
          <ChoiceGrid
            title={t('aiChat.paipanFlows.meihua.methodTitle')}
            value={method}
            options={methodOptions}
            onChange={(value) => onChange(['method'], value)}
          />
        </PaipanStepFrame>
      ),
    },
    {
      id: 'time',
      title: t('aiChat.paipanFlows.meihua.timeTitle'),
      description: t('aiChat.paipanFlows.meihua.timeDescription'),
      status: hasValidTime ? 'complete' : 'incomplete',
      content:
        method === 'time' ? (
          <PaipanStepFrame title={t('aiChat.paipanFlows.meihua.timeTitle')}>
            <ChoiceGrid
              title={t('aiChat.paipanFlows.meihua.timeTitle')}
              value={useCurrentTime ? 'now' : 'custom'}
              options={[
                {
                  value: 'now',
                  label: t('aiChat.paipanFlows.common.currentTimeSolar'),
                  hint: t('aiChat.paipanFlows.meihua.nowHint'),
                  recommended: true,
                },
                {
                  value: 'custom',
                  label: t('aiChat.paipanFlows.common.customTimeSolar'),
                  hint: t('aiChat.paipanFlows.meihua.customHint'),
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
                title={t('aiChat.paipanFlows.meihua.customTimeField')}
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
      title: t('aiChat.paipanFlows.meihua.countsTitle'),
      description: t('aiChat.paipanFlows.meihua.countsDescription'),
      status: hasValidCounts ? 'complete' : 'incomplete',
      content:
        method === 'counts' ? (
          <PaipanStepFrame title={t('aiChat.paipanFlows.meihua.countsFrameTitle')}>
            <ChoiceGrid
              title={t('aiChat.paipanFlows.meihua.countSource')}
              value={countMethod}
              options={countMethodOptions}
              columns={3}
              onChange={(value) => onChange(['countMethod'], value)}
            />
            <div className="grid gap-3 sm:grid-cols-3">
              <FieldTextInput
                title={t('aiChat.paipanFlows.meihua.upper')}
                required
                value={formatIntegerValue(upper)}
                placeholder={t('aiChat.paipanFlows.meihua.upperPlaceholder')}
                onChange={(value) =>
                  onChange(['upper'], parseIntegerValue(value))
                }
              />
              <FieldTextInput
                title={t('aiChat.paipanFlows.meihua.lower')}
                required
                value={formatIntegerValue(lower)}
                placeholder={t('aiChat.paipanFlows.meihua.lowerPlaceholder')}
                onChange={(value) =>
                  onChange(['lower'], parseIntegerValue(value))
                }
              />
              <FieldTextInput
                title={t('aiChat.paipanFlows.meihua.moving')}
                value={formatIntegerValue(moving)}
                placeholder={t('aiChat.paipanFlows.meihua.movingPlaceholder')}
                onChange={(value) =>
                  onChange(['moving'], parseIntegerValue(value))
                }
              />
            </div>
            <FieldTextInput
              title={t('aiChat.paipanFlows.common.remark')}
              value={label}
              placeholder={t('aiChat.paipanFlows.meihua.countRemarkPlaceholder')}
              onChange={(value) => onChange(['label'], value)}
            />
          </PaipanStepFrame>
        ) : null,
    },
    {
      id: 'trigrams',
      title: t('aiChat.paipanFlows.meihua.trigramsTitle'),
      description: t('aiChat.paipanFlows.meihua.trigramsDescription'),
      status: hasValidTrigrams ? 'complete' : 'incomplete',
      content:
        method === 'trigrams' ? (
          <PaipanStepFrame title={t('aiChat.paipanFlows.meihua.trigramsFrameTitle')}>
            <ChoiceGrid
              title={t('aiChat.paipanFlows.meihua.upperTrigram')}
              required
              value={
                typeof upperTrigram === 'string' ? upperTrigram : undefined
              }
              options={trigramOptions}
              onChange={(value) => onChange(['upperTrigram'], value)}
            />
            <ChoiceGrid
              title={t('aiChat.paipanFlows.meihua.lowerTrigram')}
              required
              value={
                typeof lowerTrigram === 'string' ? lowerTrigram : undefined
              }
              options={trigramOptions}
              onChange={(value) => onChange(['lowerTrigram'], value)}
            />
            <ChoiceGrid
              title={t('aiChat.paipanFlows.meihua.movingLine')}
              required
              value={movingLineValue}
              options={movingLineOptions}
              columns={3}
              onChange={(value) =>
                onChange(['movingLine'], Number.parseInt(value, 10))
              }
            />
            <FieldTextInput
              title={t('aiChat.paipanFlows.common.remark')}
              value={label}
              placeholder={t('aiChat.paipanFlows.meihua.trigramRemarkPlaceholder')}
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
