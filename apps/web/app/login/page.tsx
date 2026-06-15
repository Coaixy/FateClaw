'use client';

import { Suspense, useEffect, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { LanguageSwitcher } from '@/components/language-switcher';
import { authApi, CaptchaChallenge } from '@/features/auth/api';
import { useAuth } from '@/features/auth/hooks/use-auth';
import { useI18n } from '@/lib/i18n';
import { readLoginRedirect } from '@/lib/auth-redirect';
import { isValidMainlandChinaPhone, normalizePhoneNumber } from '@/lib/phone';
import { Loader2, RefreshCw, Eye, EyeOff } from 'lucide-react';

type AuthMode = 'login' | 'register';

const AUTH_MODES: ReadonlyArray<readonly [AuthMode, string]> = [
  ['login', 'login.authModes.login'],
  ['register', 'login.authModes.register'],
];

function inviteCodeFromSearchParams(searchParams: {
  get(name: string): string | null;
}): string {
  // 邀请链接会先写入 next 回跳参数，注册页需要从两种位置继承邀请码。
  const directCode =
    searchParams.get('invite_code') ??
    searchParams.get('invite') ??
    searchParams.get('code') ??
    '';
  if (directCode.trim()) return directCode.trim();

  const next = searchParams.get('next');
  if (!next?.startsWith('/invite')) return '';

  try {
    const nextUrl = new URL(next, 'http://local');
    return (
      nextUrl.searchParams.get('code') ??
      nextUrl.searchParams.get('invite') ??
      nextUrl.searchParams.get('invite_code') ??
      ''
    ).trim();
  } catch {
    return '';
  }
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-dvh flex items-center justify-center p-4 bg-canvas">
          <Loader2 size={24} className="animate-spin text-muted" />
        </div>
      }
    >
      <LoginContent />
    </Suspense>
  );
}

function LoginContent() {
  const { t } = useI18n();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading, login, register } = useAuth();
  const [mode, setMode] = useState<AuthMode>('login');
  const requiresSMSCaptcha = mode === 'register';

  useEffect(() => {
    if (!loading && user) {
      router.replace(readLoginRedirect('/dashboard'));
    }
  }, [loading, user, router]);

  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [phoneError, setPhoneError] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [smsSending, setSMSSending] = useState(false);
  const [smsCaptchaCode, setSMSCaptchaCode] = useState('');
  const [smsCooldown, setSMSCooldown] = useState(0);
  const [inviteCode, setInviteCode] = useState('');

  const [captcha, setCaptcha] = useState<CaptchaChallenge | null>(null);
  const [captchaLoading, setCaptchaLoading] = useState(false);
  const [captchaInput, setCaptchaInput] = useState('');

  const refreshCaptcha = useCallback(async () => {
    setCaptchaLoading(true);
    setCaptchaInput('');
    try {
      const c = await authApi.captcha();
      setCaptcha(c);
    } catch {
      setError(t('login.captchaLoadFailed'));
    } finally {
      setCaptchaLoading(false);
    }
  }, [t]);

  useEffect(() => {
    refreshCaptcha();
  }, [refreshCaptcha]);

  useEffect(() => {
    const fromQuery = inviteCodeFromSearchParams(searchParams);
    if (fromQuery.trim()) {
      setInviteCode(fromQuery.trim().toUpperCase());
      setMode('register');
    }
  }, [searchParams]);

  const switchMode = (nextMode: AuthMode) => {
    setMode(nextMode);
    setError('');
    setPhoneError('');
    setSMSCaptchaCode('');
    setCaptchaInput('');
    void refreshCaptcha();
  };

  useEffect(() => {
    if (smsCooldown <= 0) {
      return;
    }
    // 前端倒计时只负责交互提示，真实冷却仍以后端 Redis TTL 为准。
    const timer = window.setInterval(() => {
      setSMSCooldown((current) => (current <= 1 ? 0 : current - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [smsCooldown]);

  const validatePhone = () => {
    const normalizedPhone = normalizePhoneNumber(phone);
    if (!isValidMainlandChinaPhone(normalizedPhone)) {
      setPhoneError(t('login.invalidPhone'));
      return null;
    }
    return normalizedPhone;
  };

  const handleSendSMSCaptcha = async () => {
    setError('');
    setPhoneError('');

    const normalizedPhone = validatePhone();
    if (!normalizedPhone) {
      return;
    }
    if (!captcha) {
      setError(t('login.captchaNotLoaded'));
      return;
    }
    if (!captchaInput.trim()) {
      setError(t('login.enterImageCaptcha'));
      return;
    }

    setSMSSending(true);
    try {
      await authApi.sendSMSCaptcha(
        1,
        normalizedPhone,
        captcha.token,
        captchaInput,
      );
      setSMSCooldown(180);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('login.smsSendFailed'));
    } finally {
      setSMSSending(false);
      // 图形验证码 token 可能已被服务端标记为已使用，发完后统一刷新。
      await refreshCaptcha();
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setPhoneError('');

    const normalizedPhone = validatePhone();
    if (!normalizedPhone) {
      return;
    }
    if (!requiresSMSCaptcha && !captcha) {
      setError(t('login.captchaNotLoaded'));
      return;
    }
    if (requiresSMSCaptcha && !smsCaptchaCode.trim()) {
      setError(t('login.enterSmsCaptcha'));
      return;
    }

    setSubmitting(true);
    try {
      if (mode === 'register') {
        await register(
          normalizedPhone,
          password,
          smsCaptchaCode.trim(),
          inviteCode.trim() || null,
        );
      } else {
        await login(normalizedPhone, password, captcha!.token, captchaInput);
      }
      router.replace(readLoginRedirect('/dashboard'));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('login.operationFailed'));
      // 登录失败或图形码失败都刷新，避免继续使用已经失效的 nonce。
      if (!requiresSMSCaptcha) {
        await refreshCaptcha();
      }
    } finally {
      setSubmitting(false);
    }
  };

  // 将 SVG 字符串包装成 data URL 供 <img> 使用：浏览器沙箱渲染，避免 XSS
  const captchaSrc = captcha
    ? `data:image/svg+xml;utf8,${encodeURIComponent(captcha.svg)}`
    : null;

  return (
    <div className="min-h-dvh flex items-center justify-center p-4 bg-canvas">
      <div
        className="fixed inset-0 pointer-events-none z-[-1]"
        aria-hidden="true"
      >
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-[radial-gradient(ellipse,color-mix(in_srgb,var(--color-primary)_6%,transparent),transparent_70%)]" />
      </div>

      <div className="w-full max-w-[340px] px-4 sm:px-0">
        <div className="mb-5 flex justify-center">
          <LanguageSwitcher />
        </div>
        <LoginHeader mode={mode} />
        <ModeTabs mode={mode} onSwitch={switchMode} />

        <form onSubmit={handleSubmit} className="space-y-3">
          <PhoneField
            value={phone}
            error={phoneError}
            onChange={setPhone}
            onErrorChange={setPhoneError}
          />
          <PasswordField
            value={password}
            visible={showPassword}
            onChange={setPassword}
            onVisibilityChange={setShowPassword}
          />
          <CaptchaField
            value={captchaInput}
            captchaSrc={captchaSrc}
            loading={captchaLoading}
            requiresSMSCaptcha={requiresSMSCaptcha}
            onChange={setCaptchaInput}
            onRefresh={refreshCaptcha}
          />
          {requiresSMSCaptcha ? (
            <>
              <InviteCodeField value={inviteCode} onChange={setInviteCode} />
            </>
          ) : null}
          {requiresSMSCaptcha ? (
            <SMSCaptchaField
              value={smsCaptchaCode}
              sending={smsSending}
              captchaReady={Boolean(captcha)}
              captchaLoading={captchaLoading}
              cooldown={smsCooldown}
              onChange={setSMSCaptchaCode}
              onSend={handleSendSMSCaptcha}
            />
          ) : null}

          {error && <p className="text-[13px] text-error">{error}</p>}

          <SubmitButton
            mode={mode}
            submitting={submitting}
            captchaReady={Boolean(captcha)}
            requiresSMSCaptcha={requiresSMSCaptcha}
            smsCaptchaCode={smsCaptchaCode}
          />
        </form>

        <div className="mt-6 pt-4 border-t border-hairline">
          <p className="text-[12px] text-muted text-center leading-6">
            {t('login.newUserHint')}
          </p>
        </div>
      </div>
    </div>
  );
}

function InviteCodeField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();

  return (
    <div>
      <label className="block text-[13px] text-muted mb-1.5">
        {t('login.inviteCode')}
      </label>
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value.toUpperCase())}
        maxLength={64}
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        className="w-full h-10 px-3 rounded-lg border border-hairline bg-canvas text-sm placeholder:text-muted focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all duration-150"
        placeholder={t('login.invitePlaceholder')}
      />
    </div>
  );
}

function LoginHeader({ mode }: { mode: AuthMode }) {
  const { t } = useI18n();

  return (
    <div className="mb-8 text-center">
      <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-primary/15 to-primary/5 border border-primary/20 mb-4">
        <span className="text-2xl">☯</span>
      </div>
      <div className="mb-4">
        <span className="font-display text-xl font-bold tracking-tight">
          {t('common.brandName')}
        </span>
        <span className="ml-2 text-sm text-muted">FateClaw</span>
      </div>
      <h1 className="text-lg font-semibold tracking-tight">
        {mode === 'register'
          ? t('login.createPhoneAccount')
          : t('login.phoneLogin')}
      </h1>
      <p className="text-[13px] text-muted mt-1">
        {mode === 'register'
          ? t('login.registerSubtitle')
          : t('login.loginSubtitle')}
      </p>
    </div>
  );
}

function ModeTabs({
  mode,
  onSwitch,
}: {
  mode: AuthMode;
  onSwitch: (mode: AuthMode) => void;
}) {
  const { t } = useI18n();

  return (
    <div className="mb-4 grid grid-cols-2 gap-1 rounded-xl border border-hairline bg-surface-card p-1">
      {AUTH_MODES.map(([value, labelKey]) => (
        <button
          key={value}
          type="button"
          onClick={() => onSwitch(value)}
          className={`inline-flex h-9 items-center justify-center rounded-lg text-[12px] font-medium transition-colors cursor-pointer ${
            mode === value
              ? 'bg-primary text-on-primary'
              : 'text-muted hover:text-ink hover:bg-canvas'
          }`}
        >
          {t(labelKey)}
        </button>
      ))}
    </div>
  );
}

function PhoneField({
  value,
  error,
  onChange,
  onErrorChange,
}: {
  value: string;
  error: string;
  onChange: (value: string) => void;
  onErrorChange: (value: string) => void;
}) {
  const { t } = useI18n();

  return (
    <div>
      <label className="block text-[13px] text-muted mb-1.5">
        {t('login.phone')}
      </label>
      <input
        type="tel"
        inputMode="numeric"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          if (error) onErrorChange('');
        }}
        onBlur={() => {
          const normalizedPhone = normalizePhoneNumber(value);
          if (value && !isValidMainlandChinaPhone(normalizedPhone)) {
            onErrorChange(t('login.invalidPhone'));
            return;
          }
          if (value) onChange(normalizedPhone);
        }}
        required
        className={`w-full h-10 px-3 rounded-lg border bg-canvas text-sm placeholder:text-muted transition-all duration-150 ${
          error
            ? 'border-error focus:border-error focus:outline-none'
            : 'border-hairline focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20'
        }`}
        placeholder="13800138000"
      />
      {error ? <p className="text-[11px] text-error mt-1">{error}</p> : null}
    </div>
  );
}

function PasswordField({
  value,
  visible,
  onChange,
  onVisibilityChange,
}: {
  value: string;
  visible: boolean;
  onChange: (value: string) => void;
  onVisibilityChange: (value: boolean) => void;
}) {
  const { t } = useI18n();

  return (
    <div>
      <label className="block text-[13px] text-muted mb-1.5">
        {t('login.password')}
      </label>
      <div className="relative">
        <input
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required
          minLength={8}
          className="w-full h-10 px-3 pr-9 rounded-lg border border-hairline bg-canvas text-sm placeholder:text-muted focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all duration-150"
          placeholder={t('login.passwordPlaceholder')}
        />
        <button
          type="button"
          onClick={() => onVisibilityChange(!visible)}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted hover:text-ink transition-colors cursor-pointer"
          tabIndex={-1}
          aria-label={
            visible ? t('login.hidePassword') : t('login.showPassword')
          }
        >
          {visible ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
    </div>
  );
}

function CaptchaField({
  value,
  captchaSrc,
  loading,
  requiresSMSCaptcha,
  onChange,
  onRefresh,
}: {
  value: string;
  captchaSrc: string | null;
  loading: boolean;
  requiresSMSCaptcha: boolean;
  onChange: (value: string) => void;
  onRefresh: () => void;
}) {
  const { t } = useI18n();

  return (
    <div>
      <label className="block text-[13px] text-muted mb-1.5">
        {requiresSMSCaptcha ? t('login.imageCaptcha') : t('login.captcha')}
      </label>
      <div className="flex items-center gap-2">
        <div className="shrink-0 h-12 w-[140px] rounded-lg bg-canvas border border-hairline overflow-hidden flex items-center justify-center">
          {captchaSrc ? (
            <img
              src={captchaSrc}
              alt={t('login.captchaAlt')}
              className="h-full w-full select-none pointer-events-none"
              draggable={false}
            />
          ) : (
            <Loader2 size={14} className="animate-spin text-muted" />
          )}
        </div>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="w-full h-10 px-3 rounded-lg border border-hairline bg-canvas text-sm placeholder:text-muted focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all duration-150"
          placeholder={t('login.captchaPlaceholder')}
        />
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="shrink-0 h-10 w-10 flex items-center justify-center rounded-lg border border-hairline hover:bg-surface-card hover:border-primary/40 disabled:opacity-40 transition-all duration-150 cursor-pointer"
          aria-label={t('login.refreshCaptcha')}
        >
          <RefreshCw
            size={14}
            className={`text-muted ${loading ? 'animate-spin' : ''}`}
          />
        </button>
      </div>
      {requiresSMSCaptcha ? (
        <p className="mt-1 text-[11px] text-muted">
          {t('login.captchaBeforeSms')}
        </p>
      ) : null}
    </div>
  );
}

function SMSCaptchaField({
  value,
  sending,
  captchaReady,
  captchaLoading,
  cooldown,
  onChange,
  onSend,
}: {
  value: string;
  sending: boolean;
  captchaReady: boolean;
  captchaLoading: boolean;
  cooldown: number;
  onChange: (value: string) => void;
  onSend: () => void;
}) {
  const { t } = useI18n();

  return (
    <div>
      <label className="block text-[13px] text-muted mb-1.5">
        {t('login.smsCaptcha')}
      </label>
      <div className="flex items-center gap-2">
        <input
          type="text"
          inputMode="numeric"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required
          autoComplete="one-time-code"
          className="w-full h-10 px-3 rounded-lg border border-hairline bg-canvas text-sm placeholder:text-muted focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all duration-150"
          placeholder={t('login.smsPlaceholder')}
        />
        <button
          type="button"
          onClick={onSend}
          disabled={sending || captchaLoading || !captchaReady || cooldown > 0}
          className="shrink-0 h-10 min-w-[108px] px-3 rounded-lg border border-hairline bg-surface-card text-[13px] font-medium hover:border-primary/40 hover:text-ink disabled:opacity-40 transition-all duration-150 cursor-pointer flex items-center justify-center gap-1.5"
        >
          {sending && <Loader2 size={14} className="animate-spin" />}
          {cooldown > 0
            ? t('common.secondsLaterResend', { seconds: cooldown })
            : t('login.sendCaptcha')}
        </button>
      </div>
    </div>
  );
}

function SubmitButton({
  mode,
  submitting,
  captchaReady,
  requiresSMSCaptcha,
  smsCaptchaCode,
}: {
  mode: AuthMode;
  submitting: boolean;
  captchaReady: boolean;
  requiresSMSCaptcha: boolean;
  smsCaptchaCode: string;
}) {
  const { t } = useI18n();
  const disabled =
    submitting ||
    (!requiresSMSCaptcha && !captchaReady) ||
    (requiresSMSCaptcha && !smsCaptchaCode.trim());

  return (
    <button
      type="submit"
      disabled={disabled}
      className="w-full h-10 rounded-lg bg-primary text-on-primary text-sm font-semibold hover:bg-primary-active disabled:opacity-40 transition-colors duration-150 cursor-pointer flex items-center justify-center gap-1.5 mt-2"
    >
      {submitting && <Loader2 size={14} className="animate-spin" />}
      {mode === 'register' ? t('login.submitRegister') : t('login.submitLogin')}
    </button>
  );
}
