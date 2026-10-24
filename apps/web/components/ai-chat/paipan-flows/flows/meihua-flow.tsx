'use client';

import { PaipanForm } from '../shared/paipan-form';
import type { ChoiceGridOption, PaipanFlowProps } from '../types';
import { useI18n } from '@/lib/i18n';

type TranslateFn = ReturnType<typeof useI18n>['t'];

function buildMeihuaMethodOptions(t: TranslateFn): ChoiceGridOption[] {
  return [
    {
      value: 'time',
      label: t('aiChat.paipanFlows.meihua.methods.time.label'),
      hint: t('aiChat.paipanFlows.meihua.methods.time.hint'),
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

export function MeihuaFlow({
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
  const { DateTimeField, ChoiceGrid, SelectField, FieldTextInput } = fieldKit;
  const { getValueAtPath, getCurrentLocalDateParts, fromDateTimeLocalValue } =
    helpers;
  const method =
    typeof getValueAtPath(draft, ['method']) === 'string'
      ? String(getValueAtPath(draft, ['method']))
      : 'time';
  const useCurrentTime = getValueAtPath(draft, ['$useCurrentTime']) !== false;

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

  const methodOptions = buildMeihuaMethodOptions(t);
  const countMethodOptions = buildCountMethodOptions(t);
  const trigramOptions = buildTrigramOptions(t);
  const movingLineOptions = buildMovingLineOptions(t);

  return (
    <PaipanForm
      finalContent={finalContent}
      finalAction={finalAction}
      resultContent={resultContent}
    >
      <ChoiceGrid
        title={t('aiChat.paipanFlows.meihua.methodTitle')}
        value={method}
        options={methodOptions}
        onChange={(value) => onChange(['method'], value)}
      />

      {method === 'time' ? (
        <>
          <ChoiceGrid
            title={t('aiChat.paipanFlows.meihua.timeTitle')}
            value={useCurrentTime ? 'now' : 'custom'}
            options={[
              {
                value: 'now',
                label: t('aiChat.paipanFlows.common.currentTimeSolar'),
                hint: t('aiChat.paipanFlows.meihua.nowHint'),
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
        </>
      ) : null}
      {method === 'counts' ? (
        <>
          <ChoiceGrid
            title={t('aiChat.paipanFlows.meihua.countSource')}
            value={countMethod}
            options={countMethodOptions}
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
        </>
      ) : null}
      {method === 'trigrams' ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <SelectField
              title={t('aiChat.paipanFlows.meihua.upperTrigram')}
              required
              value={
                typeof upperTrigram === 'string' ? upperTrigram : undefined
              }
              placeholder={t('aiChat.paipanFlows.common.selectPlaceholder')}
              options={trigramOptions}
              onChange={(value) => onChange(['upperTrigram'], value)}
            />
            <SelectField
              title={t('aiChat.paipanFlows.meihua.lowerTrigram')}
              required
              value={
                typeof lowerTrigram === 'string' ? lowerTrigram : undefined
              }
              placeholder={t('aiChat.paipanFlows.common.selectPlaceholder')}
              options={trigramOptions}
              onChange={(value) => onChange(['lowerTrigram'], value)}
            />
            <SelectField
              title={t('aiChat.paipanFlows.meihua.movingLine')}
              required
              value={movingLineValue}
              placeholder={t('aiChat.paipanFlows.common.selectPlaceholder')}
              // 动爻的 hint 与 label 语义重复，下拉里只保留爻名。
              options={movingLineOptions.map(({ value, label }) => ({
                value,
                label,
              }))}
              onChange={(value) =>
                onChange(
                  ['movingLine'],
                  value === undefined ? undefined : Number.parseInt(value, 10),
                )
              }
            />
          </div>
          <FieldTextInput
            title={t('aiChat.paipanFlows.common.remark')}
            value={label}
            placeholder={t(
              'aiChat.paipanFlows.meihua.trigramRemarkPlaceholder',
            )}
            onChange={(value) => onChange(['label'], value)}
          />
        </>
      ) : null}
    </PaipanForm>
  );
}
