'use client';

import { Check, Loader2, Search } from 'lucide-react';
import { useReducer, useState } from 'react';

import { PaipanStepFrame } from '../shared/paipan-step-frame';
import { PaipanStepper, type PaipanStep } from '../shared/paipan-stepper';
import type { PaipanFlowProps } from '../types';
import {
  paipanApi,
  type PaipanGanzhiReverseResponse,
} from '@/features/paipan/api';
import { useI18n } from '@/lib/i18n';

type BaziInputMode = 'solar' | 'ganzhi';

interface BaziGanzhiReverseForm {
  year: string;
  month: string;
  day: string;
  hour: string;
  startYear: string;
  endYear: string;
}

const GANZHI_REVERSE_LIMIT = 20;

/**
 * 干支反查子流程的状态：四柱表单、请求中标记、错误提示与候选结果。
 *
 * 这些字段同属一次反查交互，编辑/查询任一动作都会联动清理错误，故用 reducer 收敛。
 */
interface ReverseSearchState {
  form: BaziGanzhiReverseForm;
  loading: boolean;
  error: string;
  result: PaipanGanzhiReverseResponse | null;
}

type ReverseSearchAction =
  | { type: 'updateField'; field: keyof BaziGanzhiReverseForm; value: string }
  | { type: 'searchStart' }
  | {
      type: 'searchSuccess';
      result: PaipanGanzhiReverseResponse;
      emptyMessage: string;
    }
  | { type: 'setError'; message: string }
  | { type: 'searchError'; message: string };

function reverseSearchReducer(
  state: ReverseSearchState,
  action: ReverseSearchAction,
): ReverseSearchState {
  switch (action.type) {
    case 'updateField':
      // 编辑任一字段时顺手清空上一次的错误提示，与原逐字段更新行为一致。
      return {
        ...state,
        form: { ...state.form, [action.field]: action.value },
        error: '',
      };
    case 'searchStart':
      return { ...state, loading: true, error: '' };
    case 'searchSuccess':
      // 命中为空时回填「无匹配」提示，命中非空则保持无错误。
      return {
        ...state,
        loading: false,
        result: action.result,
        error: action.result.matches.length === 0 ? action.emptyMessage : '',
      };
    case 'setError':
      // 仅用于提交前的本地校验失败，不触碰已有结果。
      return { ...state, error: action.message };
    case 'searchError':
      return { ...state, loading: false, result: null, error: action.message };
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function parseYearInput(value: string): number | null {
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isInteger(parsed)) return null;
  return parsed;
}

function formatReverseMatch(
  match: PaipanGanzhiReverseResponse['matches'][number],
): string {
  const date = `${match.year}-${pad2(match.month)}-${pad2(match.day)}`;
  if (match.hour === undefined) return date;
  return `${date} ${pad2(match.hour)}:${pad2(match.minute ?? 0)}`;
}

function PillarInput({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-[10px] text-muted">{label}</span>
      <input
        type="text"
        value={value}
        maxLength={3}
        onChange={(event) => onChange(event.currentTarget.value.trim())}
        placeholder={placeholder}
        className="h-10 w-full rounded-xl border border-hairline bg-surface-card px-3 text-[13px] text-ink placeholder:text-muted/50 focus:border-primary/40 focus:outline-none"
      />
    </label>
  );
}

function YearRangeInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-[10px] text-muted">{label}</span>
      <input
        type="text"
        inputMode="numeric"
        value={value}
        onChange={(event) =>
          onChange(event.currentTarget.value.replace(/\D/g, '').slice(0, 4))
        }
        className="h-10 w-full rounded-xl border border-hairline bg-surface-card px-3 text-[13px] text-ink focus:border-primary/40 focus:outline-none"
      />
    </label>
  );
}

function BaziModeSwitch({
  mode,
  onChange,
}: {
  mode: BaziInputMode;
  onChange: (mode: BaziInputMode) => void;
}) {
  const { t } = useI18n();
  const options: Array<{ value: BaziInputMode; label: string }> = [
    { value: 'solar', label: t('aiChat.paipanFlows.bazi.solarMode') },
    { value: 'ganzhi', label: t('aiChat.paipanFlows.bazi.ganzhiMode') },
  ];

  return (
    <div className="grid grid-cols-2 gap-1 rounded-2xl border border-hairline bg-surface-card/45 p-1">
      {options.map((option) => {
        const active = option.value === mode;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={`h-9 rounded-xl text-[12px] font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 ${
              active
                ? 'bg-primary text-on-primary shadow-[0_8px_18px_rgba(0,0,0,0.08)]'
                : 'text-muted hover:bg-surface-card hover:text-ink'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * 八字排盘的新手引导填写 flow。
 *
 * @param props 外层弹窗注入的 draft、字段组件、辅助函数和变更回调。
 * @returns 分步骤填写出生日期、出生时间和性别的排盘表单。
 */
interface BaziFlowProps extends PaipanFlowProps {
  enableGanzhiReverse?: boolean;
}

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
  enableGanzhiReverse = true,
}: BaziFlowProps) {
  const { t } = useI18n();
  const { DateField, TimeField, ChoiceGrid } = fieldKit;
  const { getValueAtPath, normalizeGenderValue } = helpers;
  const currentYear = new Date().getFullYear();
  const [inputMode, setInputMode] = useState<BaziInputMode>('solar');
  const [reverseState, reverseDispatch] = useReducer(reverseSearchReducer, {
    form: {
      year: '',
      month: '',
      day: '',
      hour: '',
      startYear: '1900',
      endYear: String(currentYear),
    },
    loading: false,
    error: '',
    result: null,
  });
  const {
    form: reverseForm,
    loading: reverseLoading,
    error: reverseError,
    result: reverseResult,
  } = reverseState;
  const gender = normalizeGenderValue(getValueAtPath(draft, ['gender']));
  const birthDate =
    typeof getValueAtPath(draft, ['solarDate']) === 'string'
      ? String(getValueAtPath(draft, ['solarDate']))
      : '';
  const birthHour = getValueAtPath(draft, ['hour']);
  const birthMinute = getValueAtPath(draft, ['minute']);
  const hasBirthHour = typeof getValueAtPath(draft, ['hour']) === 'number';
  const selectedReverseLabel =
    birthDate && typeof birthHour === 'number'
      ? `${birthDate} ${pad2(birthHour)}:${pad2(
          typeof birthMinute === 'number' ? birthMinute : 0,
        )}`
      : '';

  const updateReverseForm = (
    field: keyof BaziGanzhiReverseForm,
    value: string,
  ) => {
    reverseDispatch({ type: 'updateField', field, value });
  };

  const runReverseSearch = async () => {
    const startYear = parseYearInput(reverseForm.startYear);
    const endYear = parseYearInput(reverseForm.endYear);
    if (!reverseForm.year || !reverseForm.month || !reverseForm.day) {
      reverseDispatch({
        type: 'setError',
        message: t('aiChat.paipanFlows.bazi.missingPillars'),
      });
      return;
    }
    if (!reverseForm.hour) {
      reverseDispatch({
        type: 'setError',
        message: t('aiChat.paipanFlows.bazi.missingHourPillar'),
      });
      return;
    }
    if (startYear === null || endYear === null) {
      reverseDispatch({
        type: 'setError',
        message: t('aiChat.paipanFlows.bazi.invalidYearRange'),
      });
      return;
    }

    reverseDispatch({ type: 'searchStart' });
    try {
      const result = await paipanApi.ganzhiReverse({
        year: reverseForm.year,
        month: reverseForm.month,
        day: reverseForm.day,
        hour: reverseForm.hour,
        startYear,
        endYear,
        limit: GANZHI_REVERSE_LIMIT,
      });
      reverseDispatch({
        type: 'searchSuccess',
        result,
        emptyMessage: t('aiChat.paipanFlows.bazi.noMatches'),
      });
    } catch (error) {
      reverseDispatch({
        type: 'searchError',
        message:
          error instanceof Error
            ? error.message
            : t('aiChat.paipanFlows.bazi.reverseFailed'),
      });
    }
  };

  const applyReverseMatch = (
    match: PaipanGanzhiReverseResponse['matches'][number],
  ) => {
    onManyChanges([
      {
        path: ['solarDate'],
        value: `${match.year}-${pad2(match.month)}-${pad2(match.day)}`,
      },
      { path: ['hour'], value: match.hour },
      { path: ['minute'], value: match.minute ?? 0 },
    ]);
  };

  const genderStep: PaipanStep = {
    id: 'gender',
    title: t('aiChat.paipanFlows.bazi.genderTitle'),
    description: t('aiChat.paipanFlows.bazi.genderDescription'),
    status: gender ? 'complete' : 'incomplete',
    content: (
      <PaipanStepFrame title={t('aiChat.paipanFlows.bazi.genderTitle')}>
        <ChoiceGrid
          title={t('aiChat.paipanFlows.bazi.genderTitle')}
          required
          value={gender}
          options={[
            { value: '男', label: t('aiChat.paipanFlows.common.male') },
            { value: '女', label: t('aiChat.paipanFlows.common.female') },
          ]}
          onChange={(value) => onChange(['gender'], value)}
        />
      </PaipanStepFrame>
    ),
  };

  const solarSteps: PaipanStep[] = [
    {
      id: 'birth-date',
      title: t('aiChat.paipanFlows.bazi.birthDateTitle'),
      description: t('aiChat.paipanFlows.bazi.birthDateDescription'),
      status: birthDate ? 'complete' : 'incomplete',
      content: (
        <PaipanStepFrame title={t('aiChat.paipanFlows.bazi.birthDateTitle')}>
          <DateField
            title={t('aiChat.paipanFlows.bazi.birthDateTitle')}
            required
            value={birthDate}
            onChange={(value) => onChange(['solarDate'], value)}
          />
        </PaipanStepFrame>
      ),
    },
    {
      id: 'birth-time',
      title: t('aiChat.paipanFlows.bazi.birthTimeTitle'),
      description: t('aiChat.paipanFlows.bazi.birthTimeDescription'),
      status: hasBirthHour ? 'complete' : 'incomplete',
      content: (
        <PaipanStepFrame title={t('aiChat.paipanFlows.bazi.birthTimeTitle')}>
          <TimeField
            title={t('aiChat.paipanFlows.bazi.birthTimeTitle')}
            required
            description={t('aiChat.paipanFlows.bazi.birthTimeFieldDescription')}
            hour={birthHour}
            minute={birthMinute}
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
    genderStep,
  ];

  const ganzhiSteps: PaipanStep[] = [
    {
      id: 'ganzhi-reverse',
      title: t('aiChat.paipanFlows.bazi.reverseTitle'),
      description: t('aiChat.paipanFlows.bazi.reverseDescription'),
      status: birthDate && hasBirthHour ? 'complete' : 'incomplete',
      content: (
        <PaipanStepFrame
          title={t('aiChat.paipanFlows.bazi.reverseTitle')}
          description={t('aiChat.paipanFlows.bazi.reverseFrameDescription')}
        >
          <div className="rounded-2xl border border-hairline bg-surface-card/55 p-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <PillarInput
                label={t('aiChat.paipanFlows.bazi.yearPillar')}
                value={reverseForm.year}
                placeholder="乙巳"
                onChange={(value) => updateReverseForm('year', value)}
              />
              <PillarInput
                label={t('aiChat.paipanFlows.bazi.monthPillar')}
                value={reverseForm.month}
                placeholder="癸未"
                onChange={(value) => updateReverseForm('month', value)}
              />
              <PillarInput
                label={t('aiChat.paipanFlows.bazi.dayPillar')}
                value={reverseForm.day}
                placeholder="丁丑"
                onChange={(value) => updateReverseForm('day', value)}
              />
              <PillarInput
                label={t('aiChat.paipanFlows.bazi.hourPillar')}
                value={reverseForm.hour}
                placeholder="癸卯"
                onChange={(value) => updateReverseForm('hour', value)}
              />
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2">
              <YearRangeInput
                label={t('aiChat.paipanFlows.bazi.startYear')}
                value={reverseForm.startYear}
                onChange={(value) => updateReverseForm('startYear', value)}
              />
              <YearRangeInput
                label={t('aiChat.paipanFlows.bazi.endYear')}
                value={reverseForm.endYear}
                onChange={(value) => updateReverseForm('endYear', value)}
              />
            </div>

            <button
              type="button"
              onClick={() => void runReverseSearch()}
              disabled={reverseLoading}
              className="mt-3 inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-xl bg-primary px-3 text-[12px] font-medium text-on-primary transition-colors hover:bg-primary-active disabled:cursor-not-allowed disabled:opacity-60"
            >
              {reverseLoading ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Search size={14} />
              )}
              {t('aiChat.paipanFlows.bazi.searchCandidates')}
            </button>
          </div>

          {reverseError && (
            <p className="rounded-xl border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-[11px] leading-5 text-rose-400">
              {reverseError}
            </p>
          )}

          {reverseResult && reverseResult.matches.length > 0 && (
            <div className="rounded-2xl border border-hairline bg-surface-card/45 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-[11px] font-medium text-ink">
                  {t('aiChat.paipanFlows.bazi.candidateTime')}
                </p>
                <span className="text-[10px] text-muted">
                  {t(
                    reverseResult.truncated
                      ? 'aiChat.paipanFlows.bazi.candidateCountTruncated'
                      : 'aiChat.paipanFlows.bazi.candidateCount',
                    { count: reverseResult.total },
                  )}
                </span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {reverseResult.matches.map((match) => {
                  const label = formatReverseMatch(match);
                  const active = label === selectedReverseLabel;
                  return (
                    <button
                      key={`${match.solar}-${label}`}
                      type="button"
                      onClick={() => applyReverseMatch(match)}
                      className={`flex min-h-10 items-center justify-between gap-2 rounded-xl border px-3 text-left text-[12px] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 ${
                        active
                          ? 'border-primary bg-primary/12 text-ink'
                          : 'border-hairline bg-surface-card/55 text-muted hover:border-primary/35 hover:text-ink'
                      }`}
                    >
                      <span>{label}</span>
                      {active && <Check size={14} className="text-primary" />}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {selectedReverseLabel && (
            <div className="inline-flex min-h-8 items-center gap-1.5 rounded-xl border border-primary/20 bg-primary/10 px-3 text-[11px] text-primary">
              <Check size={13} />
              {t('aiChat.paipanFlows.bazi.applied', {
                value: selectedReverseLabel,
              })}
            </div>
          )}
        </PaipanStepFrame>
      ),
    },
    genderStep,
  ];

  const steps =
    enableGanzhiReverse && inputMode === 'ganzhi' ? ganzhiSteps : solarSteps;

  return (
    <div className="space-y-4">
      {enableGanzhiReverse && (
        <BaziModeSwitch mode={inputMode} onChange={setInputMode} />
      )}
      <PaipanStepper
        steps={steps}
        finalContent={finalContent}
        finalAction={finalAction}
        resultContent={resultContent}
        resultAction={resultAction}
        onResultStepChange={onResultStepChange}
      />
    </div>
  );
}
