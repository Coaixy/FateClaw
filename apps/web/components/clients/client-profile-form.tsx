'use client';

import { useMemo, useState } from 'react';
import { Loader2, XCircle } from 'lucide-react';

import { BottomSheet } from '@/components/ui/bottom-sheet';
import type {
  ClientProfile,
  ClientProfileUpsert,
} from '@/features/chat/client-profiles-api';
import { useConfirm } from '@/lib/use-confirm';
import { useI18n } from '@/lib/i18n';

const NAME_MAX_LENGTH = 40;
const BIRTHPLACE_MAX_LENGTH = 80;
const NOTES_MAX_LENGTH = 500;
const SHICHEN_LABELS = [
  '子',
  '丑',
  '寅',
  '卯',
  '辰',
  '巳',
  '午',
  '未',
  '申',
  '酉',
  '戌',
  '亥',
];

type GenderValue = '男' | '女' | '';

/** 给定阳历年月计算当月天数，闰年自动处理。 */
function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** 根据 24 小时制小时数取对应时辰汉字，便于用户核对出生时辰。 */
function getShichenLabel(hour: number): string {
  return SHICHEN_LABELS[Math.floor(((hour + 1) % 24) / 2)] ?? '';
}

/** 将 YYYY-MM-DD 解析为年月日数值；非法输入返回 null。 */
function parseSolarDate(
  value?: string | null,
): { year: number; month: number; day: number } | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  if (!year || !month || !day) return null;
  return { year, month, day };
}

interface BirthState {
  /** 是否填写了出生日期；未填写时不向后端提交生辰字段。 */
  hasDate: boolean;
  year: number;
  month: number;
  day: number;
  /** 是否填写了出生时间；未填写时 hour/minute 提交为 null。 */
  hasTime: boolean;
  hour: number;
  minute: number;
}

function buildInitialBirthState(initial?: ClientProfile): BirthState {
  const now = new Date();
  const parsed = parseSolarDate(initial?.solar_date);
  const hasTime =
    typeof initial?.hour === 'number' && initial.hour !== null;
  return {
    hasDate: Boolean(parsed),
    year: parsed?.year ?? now.getFullYear(),
    month: parsed?.month ?? now.getMonth() + 1,
    day: parsed?.day ?? now.getDate(),
    hasTime,
    hour: typeof initial?.hour === 'number' ? initial.hour : 0,
    minute: typeof initial?.minute === 'number' ? initial.minute : 0,
  };
}

function NumberSelect({
  label,
  value,
  options,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  options: number[];
  suffix?: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-[10px] text-muted">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(Number.parseInt(event.target.value, 10))}
        className="h-10 w-full rounded-xl border border-hairline bg-canvas px-2 text-[13px] text-ink focus:border-primary/45 focus:outline-none"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
            {suffix ? suffix(option) : ''}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * 客户档案建档 / 编辑表单。
 *
 * 以底部抽屉形式承载姓名、性别、生辰、出生地与备注的录入，生辰用简洁的
 * 年月日时分下拉，并允许用户选择是否填写出生时间。提交时把空生辰字段归一化为 null。
 *
 * @param props.initial 编辑时传入的既有客户档案；新建时为空。
 * @param props.onSave 保存回调，接收归一化后的 upsert 数据；抛错时表单内展示错误。
 * @param props.onCancel 取消 / 关闭回调。
 * @returns 客户档案表单抽屉。
 */
export function ClientProfileForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: ClientProfile;
  onSave: (data: ClientProfileUpsert) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const { confirm: confirmDialog } = useConfirm();
  const [name, setName] = useState(initial?.name ?? '');
  const [gender, setGender] = useState<GenderValue>(
    initial?.gender === '男' || initial?.gender === '女' ? initial.gender : '',
  );
  const [birth, setBirth] = useState<BirthState>(() =>
    buildInitialBirthState(initial),
  );
  const [birthplace, setBirthplace] = useState(initial?.birthplace ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const yearOptions = useMemo(() => {
    const current = new Date().getFullYear();
    const years: number[] = [];
    for (let year = current; year >= 1900; year -= 1) {
      years.push(year);
    }
    return years;
  }, []);
  const monthOptions = useMemo(
    () => Array.from({ length: 12 }, (_, index) => index + 1),
    [],
  );
  const dayOptions = useMemo(() => {
    const days = getDaysInMonth(birth.year, birth.month);
    return Array.from({ length: days }, (_, index) => index + 1);
  }, [birth.month, birth.year]);
  const hourOptions = useMemo(
    () => Array.from({ length: 24 }, (_, index) => index),
    [],
  );
  const minuteOptions = useMemo(
    () => Array.from({ length: 60 }, (_, index) => index),
    [],
  );

  const isDirty = useMemo(() => {
    const initialBirth = buildInitialBirthState(initial);
    const initialGender =
      initial?.gender === '男' || initial?.gender === '女'
        ? initial.gender
        : '';
    return (
      name !== (initial?.name ?? '') ||
      gender !== initialGender ||
      birthplace !== (initial?.birthplace ?? '') ||
      notes !== (initial?.notes ?? '') ||
      birth.hasDate !== initialBirth.hasDate ||
      birth.hasTime !== initialBirth.hasTime ||
      (birth.hasDate &&
        (birth.year !== initialBirth.year ||
          birth.month !== initialBirth.month ||
          birth.day !== initialBirth.day)) ||
      (birth.hasTime &&
        (birth.hour !== initialBirth.hour ||
          birth.minute !== initialBirth.minute))
    );
  }, [birth, birthplace, gender, initial, name, notes]);

  const updateBirth = (patch: Partial<BirthState>) => {
    setBirth((previous) => {
      const next = { ...previous, ...patch };
      // 改月份/年份后，把超出当月天数的日期收回到月末，避免出现 2 月 30 日。
      const maxDay = getDaysInMonth(next.year, next.month);
      if (next.day > maxDay) {
        next.day = maxDay;
      }
      return next;
    });
  };

  const handleCloseAttempt = async () => {
    if (!isDirty || saving) {
      onCancel();
      return;
    }
    const ok = await confirmDialog({
      title: t('clients.form.discardTitle'),
      message: t('clients.form.discardMessage'),
      confirmLabel: t('clients.form.discardConfirm'),
      cancelLabel: t('clients.form.discardCancel'),
      variant: 'danger',
    });
    if (ok) onCancel();
  };

  const handleSubmit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t('clients.form.nameRequired'));
      return;
    }

    const payload: ClientProfileUpsert = {
      name: trimmedName,
      gender: gender || null,
      solar_date: birth.hasDate
        ? `${birth.year}-${pad2(birth.month)}-${pad2(birth.day)}`
        : null,
      hour: birth.hasDate && birth.hasTime ? birth.hour : null,
      minute: birth.hasDate && birth.hasTime ? birth.minute : null,
      birthplace: birthplace.trim() || null,
      notes: notes.trim() || null,
    };

    setSaving(true);
    setError('');
    try {
      await onSave(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('clients.form.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    'w-full h-11 px-3.5 rounded-xl border border-hairline bg-canvas text-[13px] placeholder:text-muted focus:border-primary focus:ring-2 focus:ring-primary/15 focus:outline-none transition-all duration-200';

  const footer = (
    <div className="flex items-center gap-2.5 sm:gap-3 px-4 sm:px-6 py-3 sm:py-4">
      <button
        onClick={handleCloseAttempt}
        className="flex-1 sm:flex-none h-12 sm:h-10 px-4 sm:px-5 text-[13px] rounded-xl border border-hairline text-muted active:bg-surface-cream-strong sm:hover:text-ink sm:hover:bg-surface-cream-strong transition-all duration-200 cursor-pointer"
      >
        {t('common.cancel')}
      </button>
      <button
        onClick={handleSubmit}
        disabled={saving}
        className="flex-1 sm:flex-none h-12 sm:h-10 px-4 sm:px-6 text-[13px] font-medium rounded-xl bg-primary text-white active:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer flex items-center justify-center gap-2 transition-all duration-300"
      >
        {saving && <Loader2 size={14} className="animate-spin" />}
        {initial ? t('common.save') : t('clients.form.create')}
      </button>
    </div>
  );

  return (
    <BottomSheet
      open
      onClose={handleCloseAttempt}
      variant="fullscreen-sheet"
      size="md"
      title={initial ? t('clients.form.editTitle') : t('clients.form.createTitle')}
      aria-label={
        initial ? t('clients.form.editTitle') : t('clients.form.createTitle')
      }
      footer={footer}
    >
      <div className="px-4 sm:px-6 py-4 sm:py-5 space-y-5 sm:space-y-6">
        {error && (
          <div
            className="text-[12px] text-red-400 bg-red-400/10 border border-red-400/20 px-4 py-3 rounded-xl flex items-center gap-2.5"
            role="alert"
          >
            <div className="w-6 h-6 rounded-lg bg-red-400/15 flex items-center justify-center shrink-0">
              <XCircle size={14} />
            </div>
            {error}
          </div>
        )}

        {/* 基础信息：姓名 + 性别 */}
        <div>
          <div className="flex items-center gap-2 mb-3 sm:mb-4">
            <div className="w-1 h-4 rounded-full bg-primary" />
            <span className="text-[11px] sm:text-[12px] font-semibold text-ink uppercase tracking-wider">
              {t('clients.form.basicSection')}
            </span>
          </div>
          <div className="space-y-3 sm:space-y-4">
            <div>
              <label className="text-[11px] sm:text-[12px] font-medium text-muted mb-1.5 sm:mb-2 flex items-center gap-1.5">
                {t('clients.form.nameLabel')}{' '}
                <span className="text-red-400">*</span>
              </label>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={NAME_MAX_LENGTH}
                placeholder={t('clients.form.namePlaceholder')}
                autoFocus
                className={inputClass}
              />
            </div>

            <div>
              <label className="text-[11px] sm:text-[12px] font-medium text-muted mb-1.5 sm:mb-2 block">
                {t('clients.form.genderLabel')}
              </label>
              <div className="grid grid-cols-3 gap-1.5">
                {(
                  [
                    { value: '男' as const, label: t('clients.gender.male') },
                    { value: '女' as const, label: t('clients.gender.female') },
                    { value: '' as const, label: t('clients.gender.unset') },
                  ]
                ).map((option) => {
                  const active = gender === option.value;
                  return (
                    <button
                      key={option.label}
                      type="button"
                      onClick={() => setGender(option.value)}
                      className={`h-10 rounded-xl border text-[13px] font-medium transition-all duration-150 ${
                        active
                          ? 'border-primary bg-primary/12 text-ink'
                          : 'border-hairline bg-canvas text-muted hover:border-primary/35 hover:text-ink'
                      }`}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* 生辰信息 */}
        <div>
          <div className="flex items-center gap-2 mb-3 sm:mb-4">
            <div className="w-1 h-4 rounded-full bg-blue-400" />
            <span className="text-[11px] sm:text-[12px] font-semibold text-ink uppercase tracking-wider">
              {t('clients.form.birthSection')}
            </span>
          </div>

          <label className="mb-3 flex cursor-pointer items-center gap-2.5 rounded-xl border border-hairline bg-canvas px-3.5 py-2.5">
            <input
              type="checkbox"
              checked={birth.hasDate}
              onChange={(event) =>
                updateBirth({ hasDate: event.currentTarget.checked })
              }
              className="h-4 w-4 rounded border-hairline accent-primary"
            />
            <span className="text-[12px] text-ink">
              {t('clients.form.hasDateLabel')}
            </span>
          </label>

          {birth.hasDate && (
            <div className="space-y-3 rounded-xl border border-hairline bg-canvas/50 p-3">
              <div className="grid grid-cols-3 gap-2">
                <NumberSelect
                  label={t('clients.form.year')}
                  value={birth.year}
                  options={yearOptions}
                  onChange={(year) => updateBirth({ year })}
                />
                <NumberSelect
                  label={t('clients.form.month')}
                  value={birth.month}
                  options={monthOptions}
                  onChange={(month) => updateBirth({ month })}
                />
                <NumberSelect
                  label={t('clients.form.day')}
                  value={birth.day}
                  options={dayOptions}
                  onChange={(day) => updateBirth({ day })}
                />
              </div>

              <label className="flex cursor-pointer items-center gap-2.5 border-t border-hairline pt-3">
                <input
                  type="checkbox"
                  checked={birth.hasTime}
                  onChange={(event) =>
                    updateBirth({ hasTime: event.currentTarget.checked })
                  }
                  className="h-4 w-4 rounded border-hairline accent-primary"
                />
                <span className="text-[12px] text-ink">
                  {t('clients.form.hasTimeLabel')}
                </span>
              </label>

              {birth.hasTime && (
                <div className="grid grid-cols-2 gap-2">
                  <NumberSelect
                    label={t('clients.form.hour')}
                    value={birth.hour}
                    options={hourOptions}
                    suffix={(value) => ` ${getShichenLabel(value)}`}
                    onChange={(hour) => updateBirth({ hour })}
                  />
                  <NumberSelect
                    label={t('clients.form.minute')}
                    value={birth.minute}
                    options={minuteOptions}
                    onChange={(minute) => updateBirth({ minute })}
                  />
                </div>
              )}
            </div>
          )}

          <div className="mt-3">
            <label className="text-[11px] sm:text-[12px] font-medium text-muted mb-1.5 sm:mb-2 block">
              {t('clients.form.birthplaceLabel')}
            </label>
            <input
              value={birthplace}
              onChange={(event) => setBirthplace(event.target.value)}
              maxLength={BIRTHPLACE_MAX_LENGTH}
              placeholder={t('clients.form.birthplacePlaceholder')}
              className={inputClass}
            />
          </div>
        </div>

        {/* 备注 */}
        <div>
          <div className="flex items-center gap-2 mb-3 sm:mb-4">
            <div className="w-1 h-4 rounded-full bg-amber-400" />
            <span className="text-[11px] sm:text-[12px] font-semibold text-ink uppercase tracking-wider">
              {t('clients.form.notesSection')}
            </span>
          </div>
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            maxLength={NOTES_MAX_LENGTH}
            rows={4}
            placeholder={t('clients.form.notesPlaceholder')}
            className="w-full px-3.5 py-3 rounded-xl border border-hairline bg-canvas text-[13px] placeholder:text-muted focus:border-primary focus:ring-2 focus:ring-primary/15 focus:outline-none transition-all duration-200 resize-none"
          />
          <div className="flex justify-end items-center mt-1">
            <span className="text-[10px] text-muted tabular-nums">
              {notes.length}/{NOTES_MAX_LENGTH}
            </span>
          </div>
        </div>
      </div>
    </BottomSheet>
  );
}
