'use client';

import { Suspense, useEffect, useReducer, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { BrandSeal } from '@/components/brand/brand-marks';
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

/**
 * 登录/注册表单中「用户可编辑 + 即时校验提示」的一组状态。
 *
 * 它们在切换登录注册、重新校验时经常被一起清空，故合并为一个 reducer。
 */
interface LoginFormState {
  mode: AuthMode;
  phone: string;
  password: string;
  showPassword: boolean;
  phoneError: string;
  error: string;
  smsCaptchaCode: string;
  captchaInput: string;
}

const initialLoginForm: LoginFormState = {
  mode: 'login',
  phone: '',
  password: '',
  showPassword: false,
  phoneError: '',
  error: '',
  smsCaptchaCode: '',
  captchaInput: '',
};

// setText 仅覆盖类型为 string 的字段，保证计算属性写入的类型安全。
type LoginFormAction =
  | {
      type: 'setText';
      field:
        | 'phone'
        | 'password'
        | 'phoneError'
        | 'error'
        | 'smsCaptchaCode'
        | 'captchaInput';
      value: string;
    }
  | { type: 'setShowPassword'; value: boolean }
  | { type: 'switchMode'; mode: AuthMode }
  | { type: 'clearErrors' };

function loginFormReducer(
  state: LoginFormState,
  action: LoginFormAction,
): LoginFormState {
  switch (action.type) {
    case 'setText':
      return { ...state, [action.field]: action.value };
    case 'setShowPassword':
      return { ...state, showPassword: action.value };
    case 'switchMode':
      // 切换登录/注册时清掉上一模式残留的错误与验证码输入。
      return {
        ...state,
        mode: action.mode,
        error: '',
        phoneError: '',
        smsCaptchaCode: '',
        captchaInput: '',
      };
    case 'clearErrors':
      return { ...state, error: '', phoneError: '' };
  }
}

/**
 * 登录/注册表单中「异步标记 + 远程拉取 + 倒计时」的一组状态。
 *
 * 这些字段都随提交、发码、验证码刷新等异步流程流转，故与可编辑表单分开成一个 reducer。
 */
interface LoginStatusState {
  submitting: boolean;
  oauthStarting: boolean;
  smsSending: boolean;
  smsCooldown: number;
  captcha: CaptchaChallenge | null;
  captchaLoading: boolean;
}

const initialLoginStatus: LoginStatusState = {
  submitting: false,
  oauthStarting: false,
  smsSending: false,
  smsCooldown: 0,
  captcha: null,
  captchaLoading: false,
};

// setFlag 仅覆盖布尔型的进行中标记，保证计算属性写入的类型安全。
type LoginStatusAction =
  | {
      type: 'setFlag';
      field: 'submitting' | 'oauthStarting' | 'smsSending' | 'captchaLoading';
      value: boolean;
    }
  | { type: 'setCaptcha'; value: CaptchaChallenge | null }
  | { type: 'setCooldown'; value: number }
  | { type: 'tickCooldown' };

function loginStatusReducer(
  state: LoginStatusState,
  action: LoginStatusAction,
): LoginStatusState {
  switch (action.type) {
    case 'setFlag':
      return { ...state, [action.field]: action.value };
    case 'setCaptcha':
      return { ...state, captcha: action.value };
    case 'setCooldown':
      return { ...state, smsCooldown: action.value };
    case 'tickCooldown':
      // 前端倒计时每秒自减，到 0 停止；真实冷却仍以后端 Redis TTL 为准。
      return {
        ...state,
        smsCooldown: state.smsCooldown <= 1 ? 0 : state.smsCooldown - 1,
      };
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
  const { locale, t } = useI18n();
  const router = useRouter();
  const { user, loading, login, register } = useAuth();
  const [form, formDispatch] = useReducer(loginFormReducer, initialLoginForm);
  const [status, statusDispatch] = useReducer(
    loginStatusReducer,
    initialLoginStatus,
  );
  const {
    mode,
    phone,
    password,
    showPassword,
    phoneError,
    error,
    smsCaptchaCode,
    captchaInput,
  } = form;
  const {
    submitting,
    oauthStarting,
    smsSending,
    smsCooldown,
    captcha,
    captchaLoading,
  } = status;
  const phoneAuthEnabled = locale === 'zh-CN';
  const requiresSMSCaptcha = mode === 'register';

  useEffect(() => {
    if (!loading && user) {
      router.replace(readLoginRedirect('/clients'));
    }
  }, [loading, user, router]);

  const refreshCaptcha = useCallback(async () => {
    statusDispatch({ type: 'setFlag', field: 'captchaLoading', value: true });
    formDispatch({ type: 'setText', field: 'captchaInput', value: '' });
    try {
      const c = await authApi.captcha();
      statusDispatch({ type: 'setCaptcha', value: c });
    } catch {
      formDispatch({
        type: 'setText',
        field: 'error',
        value: t('login.captchaLoadFailed'),
      });
    } finally {
      statusDispatch({
        type: 'setFlag',
        field: 'captchaLoading',
        value: false,
      });
    }
  }, [t]);

  useEffect(() => {
    if (!phoneAuthEnabled) {
      statusDispatch({ type: 'setCaptcha', value: null });
      formDispatch({ type: 'setText', field: 'captchaInput', value: '' });
      return;
    }
    void refreshCaptcha();
  }, [phoneAuthEnabled, refreshCaptcha]);

  const switchMode = (nextMode: AuthMode) => {
    formDispatch({ type: 'switchMode', mode: nextMode });
    void refreshCaptcha();
  };

  useEffect(() => {
    if (smsCooldown <= 0) {
      return;
    }
    // 前端倒计时只负责交互提示，真实冷却仍以后端 Redis TTL 为准。
    const timer = window.setInterval(() => {
      statusDispatch({ type: 'tickCooldown' });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [smsCooldown]);

  const validatePhone = () => {
    const normalizedPhone = normalizePhoneNumber(phone);
    if (!isValidMainlandChinaPhone(normalizedPhone)) {
      formDispatch({
        type: 'setText',
        field: 'phoneError',
        value: t('login.invalidPhone'),
      });
      return null;
    }
    return normalizedPhone;
  };

  const handleSendSMSCaptcha = async () => {
    formDispatch({ type: 'clearErrors' });

    const normalizedPhone = validatePhone();
    if (!normalizedPhone) {
      return;
    }
    if (!captcha) {
      formDispatch({
        type: 'setText',
        field: 'error',
        value: t('login.captchaNotLoaded'),
      });
      return;
    }
    if (!captchaInput.trim()) {
      formDispatch({
        type: 'setText',
        field: 'error',
        value: t('login.enterImageCaptcha'),
      });
      return;
    }

    statusDispatch({ type: 'setFlag', field: 'smsSending', value: true });
    try {
      await authApi.sendSMSCaptcha(
        1,
        normalizedPhone,
        captcha.token,
        captchaInput,
      );
      statusDispatch({ type: 'setCooldown', value: 180 });
      formDispatch({ type: 'setText', field: 'error', value: '' });
    } catch (err) {
      formDispatch({
        type: 'setText',
        field: 'error',
        value: err instanceof Error ? err.message : t('login.smsSendFailed'),
      });
    } finally {
      statusDispatch({ type: 'setFlag', field: 'smsSending', value: false });
      // 图形验证码 token 可能已被服务端标记为已使用，发完后统一刷新。
      await refreshCaptcha();
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    formDispatch({ type: 'clearErrors' });

    const normalizedPhone = validatePhone();
    if (!normalizedPhone) {
      return;
    }
    if (!requiresSMSCaptcha && !captcha) {
      formDispatch({
        type: 'setText',
        field: 'error',
        value: t('login.captchaNotLoaded'),
      });
      return;
    }
    if (requiresSMSCaptcha && !smsCaptchaCode.trim()) {
      formDispatch({
        type: 'setText',
        field: 'error',
        value: t('login.enterSmsCaptcha'),
      });
      return;
    }

    statusDispatch({ type: 'setFlag', field: 'submitting', value: true });
    try {
      if (mode === 'register') {
        await register(normalizedPhone, password, smsCaptchaCode.trim());
      } else {
        await login(normalizedPhone, password, captcha!.token, captchaInput);
      }
      router.replace(readLoginRedirect('/clients'));
    } catch (err) {
      formDispatch({
        type: 'setText',
        field: 'error',
        value: err instanceof Error ? err.message : t('login.operationFailed'),
      });
      // 登录失败或图形码失败都刷新，避免继续使用已经失效的 nonce。
      if (!requiresSMSCaptcha) {
        await refreshCaptcha();
      }
    } finally {
      statusDispatch({ type: 'setFlag', field: 'submitting', value: false });
    }
  };

  const handleGoogleOAuthStart = () => {
    formDispatch({ type: 'setText', field: 'error', value: '' });
    statusDispatch({ type: 'setFlag', field: 'oauthStarting', value: true });
    window.location.assign(
      authApi.googleOAuthStartUrl(readLoginRedirect('/clients')),
    );
  };

  // 将 SVG 字符串包装成 data URL 供 <img> 使用：浏览器沙箱渲染，避免 XSS
  const captchaSrc = captcha
    ? `data:image/svg+xml;utf8,${encodeURIComponent(captcha.svg)}`
    : null;

  return (
    <div className="relative min-h-dvh bg-canvas">
      {/* 语言切换是最次要的功能,放右上角,不占页面视觉轴心。 */}
      <div className="absolute right-4 top-4 z-10 sm:right-6 sm:top-6">
        <LanguageSwitcher menuPlacement="bottom" />
      </div>

      <div className="flex min-h-dvh items-center justify-center p-4">
        <div className="w-full max-w-[400px]">
          <LoginHeader mode={mode} phoneAuthEnabled={phoneAuthEnabled} />

          {/* 表单装进浮起白卡:登录页有了明确的视觉主体,不再裸浮在画布上。 */}
          <div className="rounded-2xl border border-hairline bg-surface-raised p-6 shadow-raised sm:p-7">
        {phoneAuthEnabled ? (
          <>
            <ModeTabs mode={mode} onSwitch={switchMode} />

            <form onSubmit={handleSubmit} className="space-y-3">
              <PhoneField
                value={phone}
                error={phoneError}
                onChange={(value) =>
                  formDispatch({ type: 'setText', field: 'phone', value })
                }
                onErrorChange={(value) =>
                  formDispatch({ type: 'setText', field: 'phoneError', value })
                }
              />
              <PasswordField
                value={password}
                visible={showPassword}
                onChange={(value) =>
                  formDispatch({ type: 'setText', field: 'password', value })
                }
                onVisibilityChange={(value) =>
                  formDispatch({ type: 'setShowPassword', value })
                }
              />
              <CaptchaField
                value={captchaInput}
                captchaSrc={captchaSrc}
                loading={captchaLoading}
                requiresSMSCaptcha={requiresSMSCaptcha}
                onChange={(value) =>
                  formDispatch({ type: 'setText', field: 'captchaInput', value })
                }
                onRefresh={refreshCaptcha}
              />
              {requiresSMSCaptcha ? (
                <SMSCaptchaField
                  value={smsCaptchaCode}
                  sending={smsSending}
                  captchaReady={Boolean(captcha)}
                  captchaLoading={captchaLoading}
                  cooldown={smsCooldown}
                  onChange={(value) =>
                    formDispatch({
                      type: 'setText',
                      field: 'smsCaptchaCode',
                      value,
                    })
                  }
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
          </>
        ) : (
          <div className="space-y-3">
            <GoogleOAuthButton
              starting={oauthStarting}
              onStart={handleGoogleOAuthStart}
            />
            {error && <p className="text-[13px] text-error">{error}</p>}
          </div>
        )}

            <div className="mt-6 pt-4 border-t border-hairline">
              <p className="text-[12px] text-muted text-center leading-6">
                {t('login.newUserHint')}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function GoogleOAuthButton({
  starting,
  onStart,
}: {
  starting: boolean;
  onStart: () => void;
}) {
  const { t } = useI18n();

  return (
    <button
      type="button"
      onClick={onStart}
      disabled={starting}
      className="btn-tactile flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-hairline bg-surface-raised text-sm font-semibold text-ink transition-all duration-150 hover:border-primary/40 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-55 cursor-pointer"
    >
      {starting ? (
        <Loader2 size={14} className="animate-spin" />
      ) : (
        <span className="flex h-5 w-5 items-center justify-center rounded-full border border-hairline bg-white text-[12px] font-bold text-[#4285f4]">
          G
        </span>
      )}
      {starting ? t('login.googleStarting') : t('login.googleContinue')}
    </button>
  );
}

function LoginHeader({
  mode,
  phoneAuthEnabled,
}: {
  mode: AuthMode;
  phoneAuthEnabled: boolean;
}) {
  const { t } = useI18n();

  const brandName = t('common.brandName');

  return (
    <div className="mb-7 text-center">
      {/* 品牌方印:「守义」白文印,与侧栏 Logo 同源。 */}
      <BrandSeal className="mx-auto mb-4 h-14 w-14 shadow-sm" />
      {/* 品牌名是页面唯一的衬线大字;英文品牌名与 FateClaw 相同时不重复显示副名。 */}
      <h1 className="font-display text-[26px] font-bold tracking-tight text-ink">
        {brandName}
        {brandName !== 'FateClaw' && (
          <span className="ml-2 align-middle text-[13px] font-medium tracking-[0.12em] text-muted">
            FATECLAW
          </span>
        )}
      </h1>
      <p className="mt-2 text-[13px] text-muted">
        {phoneAuthEnabled
          ? mode === 'register'
            ? t('login.registerSubtitle')
            : t('login.loginSubtitle')
          : t('login.googleSubtitle')}
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
              ? 'btn-tactile-primary text-on-primary'
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
      className="btn-tactile-primary w-full h-10 rounded-lg text-on-primary text-sm font-semibold disabled:opacity-40 transition-all duration-150 cursor-pointer active:scale-[0.99] flex items-center justify-center gap-1.5 mt-2"
    >
      {submitting && <Loader2 size={14} className="animate-spin" />}
      {mode === 'register' ? t('login.submitRegister') : t('login.submitLogin')}
    </button>
  );
}
