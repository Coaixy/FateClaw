'use client';

import {
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Smartphone,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useReducer,
  useState,
  type FormEvent,
} from 'react';

import { authApi, type CaptchaChallenge } from '@/features/auth/api';
import { useAuth } from '@/features/auth/hooks/use-auth';
import { setAuthToken } from '@/lib/auth-scoped-cache';
import { useI18n } from '@/lib/i18n';
import { useToast } from '@/lib/use-toast';

type SecurityMode = 'change' | 'recover';

interface PasswordInputProps {
  label: string;
  placeholder: string;
  hideLabel: string;
  showLabel: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

const PASSWORD_MIN_LENGTH = 8;

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/** 修改密码表单态：当前/新/确认密码及错误与提交状态。 */
interface ChangeFormState {
  currentPassword: string;
  nextPassword: string;
  confirmPassword: string;
  error: string;
  submitting: boolean;
}

type ChangeFormAction =
  | {
      type: 'field';
      name: 'currentPassword' | 'nextPassword' | 'confirmPassword';
      value: string;
    }
  | { type: 'error'; value: string }
  | { type: 'submitting'; value: boolean }
  | { type: 'resetSecret' };

const initialChangeForm: ChangeFormState = {
  currentPassword: '',
  nextPassword: '',
  confirmPassword: '',
  error: '',
  submitting: false,
};

/** 修改密码表单归约器；resetSecret 在改密成功后清空三处密码输入。 */
function changeFormReducer(
  state: ChangeFormState,
  action: ChangeFormAction,
): ChangeFormState {
  switch (action.type) {
    case 'field':
      return { ...state, [action.name]: action.value };
    case 'error':
      return { ...state, error: action.value };
    case 'submitting':
      return { ...state, submitting: action.value };
    case 'resetSecret':
      return {
        ...state,
        currentPassword: '',
        nextPassword: '',
        confirmPassword: '',
      };
  }
}

/** 找回密码表单态：图形验证码、短信验证码与新密码等。 */
interface RecoverFormState {
  captcha: CaptchaChallenge | null;
  captchaInput: string;
  captchaLoading: boolean;
  smsCode: string;
  /** 前端短信冷却秒数，仅用于交互反馈，真实冷却以后端为准。 */
  smsCooldown: number;
  smsSending: boolean;
  password: string;
  confirmPassword: string;
  error: string;
  submitting: boolean;
}

type RecoverFormAction =
  | {
      type: 'field';
      name: 'captchaInput' | 'smsCode' | 'password' | 'confirmPassword';
      value: string;
    }
  | { type: 'captchaLoading' }
  | { type: 'captchaLoaded'; captcha: CaptchaChallenge }
  | { type: 'captchaLoadEnd' }
  | { type: 'error'; value: string }
  | { type: 'sending'; value: boolean }
  | { type: 'cooldown'; value: number }
  | { type: 'cooldownTick' }
  | { type: 'submitting'; value: boolean }
  | { type: 'resetSecret' };

const initialRecoverForm: RecoverFormState = {
  captcha: null,
  captchaInput: '',
  captchaLoading: false,
  smsCode: '',
  smsCooldown: 0,
  smsSending: false,
  password: '',
  confirmPassword: '',
  error: '',
  submitting: false,
};

/**
 * 找回密码表单归约器。
 *
 * captchaLoading 开始刷新图形验证码时同时清空已输入的验证码（对应原先
 * setCaptchaLoading(true)+setCaptchaInput('')）；cooldownTick 用于每秒递减冷却；
 * resetSecret 在重置成功后清空短信码与新密码。
 */
function recoverFormReducer(
  state: RecoverFormState,
  action: RecoverFormAction,
): RecoverFormState {
  switch (action.type) {
    case 'field':
      return { ...state, [action.name]: action.value };
    case 'captchaLoading':
      return { ...state, captchaLoading: true, captchaInput: '' };
    case 'captchaLoaded':
      return { ...state, captcha: action.captcha };
    case 'captchaLoadEnd':
      return { ...state, captchaLoading: false };
    case 'error':
      return { ...state, error: action.value };
    case 'sending':
      return { ...state, smsSending: action.value };
    case 'cooldown':
      return { ...state, smsCooldown: action.value };
    case 'cooldownTick':
      return {
        ...state,
        smsCooldown: state.smsCooldown <= 1 ? 0 : state.smsCooldown - 1,
      };
    case 'submitting':
      return { ...state, submitting: action.value };
    case 'resetSecret':
      return { ...state, smsCode: '', password: '', confirmPassword: '' };
  }
}

function PasswordInput({
  label,
  placeholder,
  hideLabel,
  showLabel,
  value,
  onChange,
  disabled = false,
}: PasswordInputProps) {
  const [showPassword, setShowPassword] = useState(false);

  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-medium text-muted">
        {label}
      </span>
      <div className="relative">
        <input
          type={showPassword ? 'text' : 'password'}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className="h-10 w-full rounded-lg border border-hairline bg-canvas/92 px-3 pr-10 text-[13px] transition-all duration-150 placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/18 disabled:cursor-not-allowed disabled:opacity-70"
          placeholder={placeholder}
        />
        <button
          type="button"
          onClick={() => setShowPassword((current) => !current)}
          disabled={disabled}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
          aria-label={showPassword ? hideLabel : showLabel}
        >
          {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
    </label>
  );
}

function InlineMessage({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-[12px] leading-relaxed text-red-400"
    >
      {message}
    </div>
  );
}

export function TabSecurity() {
  const { user, refresh } = useAuth();
  const { toast } = useToast();
  const { t } = useI18n();
  const [mode, setMode] = useState<SecurityMode>('change');

  const [change, dispatchChange] = useReducer(
    changeFormReducer,
    initialChangeForm,
  );
  const {
    currentPassword,
    nextPassword,
    confirmPassword,
    error: changeError,
    submitting: changeSubmitting,
  } = change;

  const [recover, dispatchRecover] = useReducer(
    recoverFormReducer,
    initialRecoverForm,
  );
  const {
    captcha,
    captchaInput,
    captchaLoading,
    smsCode,
    smsCooldown,
    smsSending,
    password: recoverPassword,
    confirmPassword: recoverConfirmPassword,
    error: recoverError,
    submitting: recoverSubmitting,
  } = recover;

  const phone = user?.phone_masked ?? user?.phone ?? '';
  const phoneVerified = user?.phone_verified ?? false;
  const canChangePassword = user?.has_password ?? true;
  const canUsePhoneSecurity = Boolean(phone && phoneVerified);
  const phoneStatusLabel = !phone
    ? t('pages.profile.statusUnbound')
    : phoneVerified
      ? t('pages.profile.statusVerified')
      : t('pages.profile.statusBound');
  const phoneStatusTone = phoneVerified
    ? 'border-primary/20 bg-[color-mix(in_srgb,var(--color-primary)_14%,transparent)] text-primary'
    : 'border-hairline bg-canvas text-muted';
  const phoneSecurityHint = !phone
    ? t('pages.profile.phoneNeedsBinding')
    : phoneVerified
      ? t('pages.profile.phoneUsable')
      : t('pages.profile.phoneWaiting');

  const refreshCaptcha = useCallback(async () => {
    dispatchRecover({ type: 'captchaLoading' });
    try {
      const challenge = await authApi.captcha();
      dispatchRecover({ type: 'captchaLoaded', captcha: challenge });
    } catch (error) {
      dispatchRecover({
        type: 'error',
        value: getErrorMessage(error, t('login.captchaLoadFailed')),
      });
    } finally {
      dispatchRecover({ type: 'captchaLoadEnd' });
    }
  }, [t]);

  useEffect(() => {
    if (mode === 'recover') {
      void refreshCaptcha();
    }
  }, [mode, refreshCaptcha]);

  useEffect(() => {
    if (smsCooldown <= 0) return;
    // 前端倒计时只负责交互反馈，真实发送冷却仍以后端 Redis 为准。
    const timer = window.setInterval(() => {
      dispatchRecover({ type: 'cooldownTick' });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [smsCooldown]);

  function validatePasswordPair(
    password: string,
    confirmation: string,
  ): string | null {
    if (password.length < PASSWORD_MIN_LENGTH) {
      return t('pages.profile.passwordMin', { min: PASSWORD_MIN_LENGTH });
    }
    if (password !== confirmation) {
      return t('pages.profile.passwordMismatch');
    }
    return null;
  }

  async function handleChangePassword(event: FormEvent) {
    event.preventDefault();
    dispatchChange({ type: 'error', value: '' });

    if (!canChangePassword) {
      dispatchChange({ type: 'error', value: t('pages.profile.passwordNotSet') });
      return;
    }
    if (!currentPassword) {
      dispatchChange({
        type: 'error',
        value: t('pages.profile.enterCurrentPassword'),
      });
      return;
    }
    const validationError = validatePasswordPair(nextPassword, confirmPassword);
    if (validationError) {
      dispatchChange({ type: 'error', value: validationError });
      return;
    }

    dispatchChange({ type: 'submitting', value: true });
    try {
      await authApi.changePassword(currentPassword, nextPassword);
      dispatchChange({ type: 'resetSecret' });
      toast('success', t('pages.profile.passwordUpdated'));
    } catch (error) {
      dispatchChange({
        type: 'error',
        value: getErrorMessage(error, t('pages.profile.changePasswordFailed')),
      });
    } finally {
      dispatchChange({ type: 'submitting', value: false });
    }
  }

  async function handleSendSMSCaptcha() {
    dispatchRecover({ type: 'error', value: '' });
    if (!canUsePhoneSecurity) {
      dispatchRecover({
        type: 'error',
        value: phone
          ? t('pages.profile.phoneNotVerified')
          : t('pages.profile.accountPhoneUnbound'),
      });
      return;
    }
    if (!captcha) {
      dispatchRecover({
        type: 'error',
        value: t('pages.profile.loadCaptchaFirst'),
      });
      return;
    }
    if (!captchaInput.trim()) {
      dispatchRecover({
        type: 'error',
        value: t('pages.profile.enterImageCaptcha'),
      });
      return;
    }

    dispatchRecover({ type: 'sending', value: true });
    try {
      await authApi.sendCurrentUserSMSCaptcha(
        captcha.token,
        captchaInput.trim(),
      );
      dispatchRecover({ type: 'cooldown', value: 180 });
      toast('success', t('pages.profile.smsSent'));
    } catch (error) {
      dispatchRecover({
        type: 'error',
        value: getErrorMessage(error, t('pages.profile.smsSendFailed')),
      });
    } finally {
      dispatchRecover({ type: 'sending', value: false });
      await refreshCaptcha();
    }
  }

  async function handleResetPassword(event: FormEvent) {
    event.preventDefault();
    dispatchRecover({ type: 'error', value: '' });

    if (!canUsePhoneSecurity) {
      dispatchRecover({
        type: 'error',
        value: phone
          ? t('pages.profile.phoneNotVerified')
          : t('pages.profile.accountPhoneUnbound'),
      });
      return;
    }
    if (!smsCode.trim()) {
      dispatchRecover({
        type: 'error',
        value: t('pages.profile.enterSmsCaptcha'),
      });
      return;
    }
    const validationError = validatePasswordPair(
      recoverPassword,
      recoverConfirmPassword,
    );
    if (validationError) {
      dispatchRecover({ type: 'error', value: validationError });
      return;
    }

    dispatchRecover({ type: 'submitting', value: true });
    try {
      const response = await authApi.resetCurrentUserPassword(
        recoverPassword,
        smsCode.trim(),
      );
      setAuthToken(response.token);
      await refresh();
      dispatchRecover({ type: 'resetSecret' });
      toast('success', t('pages.profile.passwordReset'));
    } catch (error) {
      dispatchRecover({
        type: 'error',
        value: getErrorMessage(error, t('pages.profile.resetPasswordFailed')),
      });
    } finally {
      dispatchRecover({ type: 'submitting', value: false });
    }
  }

  const captchaSrc = captcha
    ? `data:image/svg+xml;utf8,${encodeURIComponent(captcha.svg)}`
    : null;

  return (
    <section className="overflow-hidden rounded-xl border border-hairline">
      <div className="border-b border-hairline bg-surface-card px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <ShieldCheck size={14} className="text-muted" />
          <div>
            <p className="text-[12px] font-medium">
              {t('pages.profile.securityTitle')}
            </p>
            <p className="text-[10px] text-muted">
              {t('pages.profile.securityDescription')}
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-3.5 bg-surface-card px-4 py-3">
        <div className="flex flex-col gap-2.5 rounded-xl border border-hairline bg-canvas/36 px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <div className="flex h-[26px] w-[26px] items-center justify-center rounded-lg bg-surface-card/90">
                <Smartphone size={13} className="text-muted" />
              </div>
              <p className="text-[11px] font-medium">
                {t('pages.profile.phoneVerification')}
              </p>
              <span
                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[9px] font-medium tracking-[0.02em] ${phoneStatusTone}`}
              >
                {phoneStatusLabel}
              </span>
            </div>
            <p className="text-[10px] leading-5 text-muted">
              {phone || t('pages.profile.unboundPhone')}
            </p>
          </div>
          <span className="inline-flex h-9 items-center justify-center rounded-lg border border-hairline bg-surface-card/85 px-3 text-[11px] font-medium text-muted">
            {phoneSecurityHint}
          </span>
        </div>

        <div className="space-y-2.5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div className="flex items-center gap-2.5">
              <div className="flex h-[28px] w-[28px] items-center justify-center rounded-lg bg-canvas/45">
                {mode === 'change' ? (
                  <KeyRound size={13} className="text-muted" />
                ) : (
                  <RotateCcw size={13} className="text-muted" />
                )}
              </div>
              <div>
                <p className="text-[11px] font-medium">
                  {t('pages.profile.passwordOperation')}
                </p>
                <p className="text-[10px] text-muted">
                  {mode === 'change'
                    ? t('pages.profile.passwordChangeDescription')
                    : t('pages.profile.passwordRecoverDescription')}
                </p>
              </div>
            </div>

            <div className="grid w-full grid-cols-2 gap-1 rounded-xl border border-hairline bg-canvas/50 p-1 sm:w-auto">
              {(['change', 'recover'] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => {
                    setMode(item);
                    dispatchChange({ type: 'error', value: '' });
                    dispatchRecover({ type: 'error', value: '' });
                  }}
                  className={`inline-flex h-[34px] items-center justify-center rounded-lg border px-3 text-[11px] font-medium transition-all cursor-pointer ${
                    mode === item
                      ? 'border-primary/20 bg-[color-mix(in_srgb,var(--color-primary)_85%,white_12%)] text-on-primary shadow-[0_1px_0_rgba(255,255,255,0.22)_inset]'
                      : 'border-transparent text-muted hover:bg-canvas hover:text-ink'
                  }`}
                >
                  {item === 'change'
                    ? t('pages.profile.changePassword')
                    : t('pages.profile.recoverPassword')}
                </button>
              ))}
            </div>
          </div>

          {mode === 'change' ? (
            <form
              className="space-y-3 rounded-xl border border-hairline bg-canvas/36 p-3.5"
              onSubmit={handleChangePassword}
            >
              <InlineMessage
                message={
                  changeError ||
                  (!canChangePassword ? t('pages.profile.passwordNotSet') : '')
                }
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <PasswordInput
                    label={t('pages.profile.currentPassword')}
                    placeholder={t('pages.profile.currentPasswordPlaceholder')}
                    hideLabel={t('pages.profile.hidePassword')}
                    showLabel={t('pages.profile.showPassword')}
                    value={currentPassword}
                    onChange={(value) =>
                      dispatchChange({
                        type: 'field',
                        name: 'currentPassword',
                        value,
                      })
                    }
                    disabled={changeSubmitting || !canChangePassword}
                  />
                </div>
                <PasswordInput
                  label={t('pages.profile.newPassword')}
                  placeholder={t('pages.profile.newPasswordPlaceholder')}
                  hideLabel={t('pages.profile.hidePassword')}
                  showLabel={t('pages.profile.showPassword')}
                  value={nextPassword}
                  onChange={(value) =>
                    dispatchChange({
                      type: 'field',
                      name: 'nextPassword',
                      value,
                    })
                  }
                  disabled={changeSubmitting || !canChangePassword}
                />
                <PasswordInput
                  label={t('pages.profile.confirmNewPassword')}
                  placeholder={t('pages.profile.confirmNewPasswordPlaceholder')}
                  hideLabel={t('pages.profile.hidePassword')}
                  showLabel={t('pages.profile.showPassword')}
                  value={confirmPassword}
                  onChange={(value) =>
                    dispatchChange({
                      type: 'field',
                      name: 'confirmPassword',
                      value,
                    })
                  }
                  disabled={changeSubmitting || !canChangePassword}
                />
              </div>

              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={changeSubmitting || !canChangePassword}
                  className="inline-flex h-[38px] items-center justify-center gap-2 rounded-lg border border-primary/18 bg-[color-mix(in_srgb,var(--color-primary)_78%,white_16%)] px-4 text-[12px] font-semibold text-on-primary shadow-[0_1px_0_rgba(255,255,255,0.22)_inset] disabled:cursor-not-allowed disabled:opacity-55 cursor-pointer"
                >
                  {changeSubmitting && (
                    <Loader2 size={13} className="animate-spin" />
                  )}
                  {t('pages.profile.saveNewPassword')}
                </button>
              </div>
            </form>
          ) : (
            <form
              className="space-y-3 rounded-xl border border-hairline bg-canvas/36 p-3.5"
              onSubmit={handleResetPassword}
            >
              <InlineMessage message={recoverError} />
              <label className="block">
                <span className="mb-1.5 block text-[11px] font-medium text-muted">
                  {t('pages.profile.recoverPhone')}
                </span>
                <input
                  type="tel"
                  value={phone}
                  disabled
                  className="h-10 w-full rounded-lg border border-hairline bg-canvas/92 px-3 text-[13px] text-muted opacity-80 cursor-not-allowed"
                  placeholder={t('pages.profile.recoverPhonePlaceholder')}
                />
              </label>

              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                <label className="block">
                  <span className="mb-1.5 block text-[11px] font-medium text-muted">
                    {t('pages.profile.imageCaptcha')}
                  </span>
                  <input
                    value={captchaInput}
                    onChange={(event) =>
                      dispatchRecover({
                        type: 'field',
                        name: 'captchaInput',
                        value: event.target.value,
                      })
                    }
                    disabled={captchaLoading || smsSending}
                    className="h-10 w-full rounded-lg border border-hairline bg-canvas/92 px-3 text-[13px] transition-all duration-150 placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/18 disabled:cursor-not-allowed disabled:opacity-70"
                    placeholder={t('pages.profile.imageCaptchaPlaceholder')}
                  />
                </label>
                <div className="flex items-center gap-2">
                  <div className="flex h-10 w-[104px] items-center justify-center overflow-hidden rounded-lg border border-hairline bg-canvas">
                    {captchaSrc ? (
                      <img
                        src={captchaSrc}
                        alt={t('pages.profile.captchaAlt')}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <span className="text-[11px] text-muted">
                        {t('pages.profile.captchaUnloaded')}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => void refreshCaptcha()}
                    disabled={captchaLoading}
                    className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-hairline text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-60 cursor-pointer"
                    aria-label={t('pages.profile.refreshImageCaptcha')}
                  >
                    {captchaLoading ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <RefreshCw size={14} />
                    )}
                  </button>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                <label className="block">
                  <span className="mb-1.5 block text-[11px] font-medium text-muted">
                    {t('pages.profile.smsCaptcha')}
                  </span>
                  <input
                    value={smsCode}
                    onChange={(event) =>
                      dispatchRecover({
                        type: 'field',
                        name: 'smsCode',
                        value: event.target.value,
                      })
                    }
                    disabled={recoverSubmitting}
                    className="h-10 w-full rounded-lg border border-hairline bg-canvas/92 px-3 text-[13px] transition-all duration-150 placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/18 disabled:cursor-not-allowed disabled:opacity-70"
                    placeholder={t('pages.profile.smsCaptchaPlaceholder')}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => void handleSendSMSCaptcha()}
                  disabled={
                    !canUsePhoneSecurity ||
                    smsSending ||
                    smsCooldown > 0 ||
                    captchaLoading
                  }
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-hairline bg-surface-card/82 px-4 text-[12px] font-medium text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-60 cursor-pointer"
                >
                  {smsSending && <Loader2 size={13} className="animate-spin" />}
                  {smsCooldown > 0
                    ? `${smsCooldown}s`
                    : t('pages.profile.sendCaptcha')}
                </button>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <PasswordInput
                  label={t('pages.profile.newPassword')}
                  placeholder={t('pages.profile.newPasswordPlaceholder')}
                  hideLabel={t('pages.profile.hidePassword')}
                  showLabel={t('pages.profile.showPassword')}
                  value={recoverPassword}
                  onChange={(value) =>
                    dispatchRecover({ type: 'field', name: 'password', value })
                  }
                  disabled={recoverSubmitting}
                />
                <PasswordInput
                  label={t('pages.profile.confirmNewPassword')}
                  placeholder={t('pages.profile.confirmNewPasswordPlaceholder')}
                  hideLabel={t('pages.profile.hidePassword')}
                  showLabel={t('pages.profile.showPassword')}
                  value={recoverConfirmPassword}
                  onChange={(value) =>
                    dispatchRecover({
                      type: 'field',
                      name: 'confirmPassword',
                      value,
                    })
                  }
                  disabled={recoverSubmitting}
                />
              </div>

              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={!canUsePhoneSecurity || recoverSubmitting}
                  className="inline-flex h-[38px] items-center justify-center gap-2 rounded-lg border border-primary/18 bg-[color-mix(in_srgb,var(--color-primary)_78%,white_16%)] px-4 text-[12px] font-semibold text-on-primary shadow-[0_1px_0_rgba(255,255,255,0.22)_inset] disabled:cursor-not-allowed disabled:opacity-55 cursor-pointer"
                >
                  {recoverSubmitting && (
                    <Loader2 size={13} className="animate-spin" />
                  )}
                  {t('pages.profile.resetPassword')}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </section>
  );
}
