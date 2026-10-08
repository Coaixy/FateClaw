'use client';

import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Sparkles,
  Store,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { OnboardingGuideStep } from '@/components/ai-chat/use-onboarding-guide-status';
import { useI18n } from '@/lib/i18n';

interface OnboardingGuideDialogProps {
  open: boolean;
  step: OnboardingGuideStep;
  modelReady: boolean;
  skillReady: boolean;
  modelLoading: boolean;
  skillLoading: boolean;
  modelError: string;
  skillError: string;
  hasAnyInstalledSkill: boolean;
  onClose: () => void;
  onSaveStep: (step: OnboardingGuideStep) => void;
  onRetry: () => void;
  onOpenSkillMarket: () => void;
  onComplete: () => void;
}

const steps: Array<{ key: OnboardingGuideStep; labelKey: string }> = [
  { key: 'welcome', labelKey: 'aiChat.onboarding.steps.welcome' },
  { key: 'model', labelKey: 'aiChat.onboarding.steps.model' },
  { key: 'skill', labelKey: 'aiChat.onboarding.steps.skill' },
  { key: 'done', labelKey: 'aiChat.onboarding.steps.done' },
];

function getStepIndex(step: OnboardingGuideStep) {
  return Math.max(
    0,
    steps.findIndex((item) => item.key === step),
  );
}

/**
 * AI Chat 首次使用的轻量启动向导弹层。
 *
 * @param props 向导打开状态、模型/Skill 就绪状态以及跳转操作。
 * @returns 当前向导步骤对应的对话框。
 */
export function OnboardingGuideDialog(props: OnboardingGuideDialogProps) {
  const { t } = useI18n();

  if (!props.open) return null;

  const currentIndex = getStepIndex(props.step);
  const goNextFromWelcome = () => {
    props.onSaveStep(props.modelReady ? 'skill' : 'model');
  };
  const goNextFromModel = () => {
    props.onSaveStep(props.skillReady ? 'done' : 'skill');
  };
  const goNextFromSkill = () => {
    props.onSaveStep('done');
  };

  return (
    <div className="fixed inset-0 z-[160] flex min-h-dvh items-center justify-center bg-ink/35 px-3 py-3 text-ink backdrop-blur-sm sm:px-6 sm:py-6">
      <section
        aria-labelledby="ai-chat-onboarding-title"
        aria-modal="true"
        role="dialog"
        className="w-full max-w-lg"
      >
        <div className="overflow-hidden rounded-lg border border-hairline bg-surface-raised shadow-2xl shadow-ink/20">
          <div className="border-b border-hairline px-4 py-4 sm:px-5">
            <div className="flex items-start gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Sparkles size={18} aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted">
                  {t('aiChat.onboarding.eyebrow')}
                </p>
                <h1
                  id="ai-chat-onboarding-title"
                  className="mt-1 text-lg font-semibold leading-tight text-ink sm:text-xl"
                >
                  {t(`aiChat.onboarding.titles.${props.step}`)}
                </h1>
              </div>
              <button
                type="button"
                aria-label={t('aiChat.onboarding.close')}
                onClick={props.onClose}
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-card hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35"
              >
                <X size={16} />
              </button>
            </div>

            <div className="mt-4 grid grid-cols-4 gap-1.5">
              {steps.map((item, index) => {
                const active = index === currentIndex;
                const completed = index < currentIndex;
                return (
                  <div
                    key={item.key}
                    className={`min-w-0 rounded-md border px-2 py-1.5 text-center text-[10px] font-medium transition-colors ${
                      active
                        ? 'border-primary/40 bg-primary/10 text-primary'
                        : completed
                          ? 'border-primary/20 bg-primary/5 text-primary'
                          : 'border-hairline bg-surface-card/60 text-muted'
                    }`}
                    aria-current={active ? 'step' : undefined}
                  >
                    {t(item.labelKey)}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="px-4 py-4 sm:px-5">
            {props.step === 'welcome' ? (
              <WelcomeStep
                modelReady={props.modelReady}
                skillReady={props.skillReady}
              />
            ) : props.step === 'model' ? (
              <ModelStep
                ready={props.modelReady}
                loading={props.modelLoading}
                error={props.modelError}
              />
            ) : props.step === 'skill' ? (
              <SkillStep
                ready={props.skillReady}
                loading={props.skillLoading}
                error={props.skillError}
                hasAnyInstalledSkill={props.hasAnyInstalledSkill}
              />
            ) : (
              <DoneStep />
            )}
          </div>

          <div className="border-t border-hairline bg-surface-soft px-4 py-3 sm:px-5">
            {props.step === 'welcome' ? (
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button variant="ghost" onClick={props.onClose}>
                  {t('aiChat.onboarding.later')}
                </Button>
                <Button
                  icon={<ArrowRight size={14} />}
                  onClick={goNextFromWelcome}
                >
                  {t('aiChat.onboarding.startConfig')}
                </Button>
              </div>
            ) : props.step === 'model' ? (
              <ModelActions
                ready={props.modelReady}
                loading={props.modelLoading}
                onRetry={props.onRetry}
                onClose={props.onClose}
                onNext={goNextFromModel}
              />
            ) : props.step === 'skill' ? (
              <SkillActions
                ready={props.skillReady}
                loading={props.skillLoading}
                error={props.skillError}
                onRetry={props.onRetry}
                onClose={props.onClose}
                onNext={goNextFromSkill}
                onOpenSkillMarket={props.onOpenSkillMarket}
              />
            ) : (
              <div className="flex justify-end">
                <Button onClick={props.onComplete}>
                  {t('aiChat.onboarding.startAsking')}
                </Button>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function WelcomeStep({
  modelReady,
  skillReady,
}: {
  modelReady: boolean;
  skillReady: boolean;
}) {
  const { t } = useI18n();

  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-6 text-body">
        {t('aiChat.onboarding.welcomeDescription')}
      </p>
      <div className="grid gap-2">
        <StatusCard
          title={t('aiChat.onboarding.officialModel')}
          description={t('aiChat.onboarding.officialModelDescription')}
          ready={modelReady}
        />
        <StatusCard
          title={t('aiChat.onboarding.skill')}
          description={t('aiChat.onboarding.skillDescription')}
          ready={skillReady}
        />
      </div>
    </div>
  );
}

function ModelStep({
  ready,
  loading,
  error,
}: {
  ready: boolean;
  loading: boolean;
  error: string;
}) {
  const { t } = useI18n();

  if (loading) {
    return <LoadingState label={t('aiChat.onboarding.modelLoading')} />;
  }

  if (error) {
    return (
      <AlertState
        title={t('aiChat.onboarding.modelErrorTitle')}
        description={error}
      />
    );
  }

  if (ready) {
    return (
      <StatusCard
        title={t('aiChat.onboarding.modelReadyTitle')}
        description={t('aiChat.onboarding.modelReadyDescription')}
        ready={ready}
      />
    );
  }

  return (
    <AlertState
      title={t('aiChat.onboarding.noOfficialModelTitle')}
      description={t('aiChat.onboarding.noOfficialModelDescription')}
    />
  );
}

function SkillStep({
  ready,
  loading,
  error,
  hasAnyInstalledSkill,
}: {
  ready: boolean;
  loading: boolean;
  error: string;
  hasAnyInstalledSkill: boolean;
}) {
  const { t } = useI18n();

  if (loading) {
    return <LoadingState label={t('aiChat.onboarding.skillLoading')} />;
  }

  if (error) {
    return (
      <AlertState
        title={t('aiChat.onboarding.skillErrorTitle')}
        description={error}
      />
    );
  }

  return (
    <StatusCard
      title={
        ready
          ? t('aiChat.onboarding.skillReadyTitle')
          : t('aiChat.onboarding.skillNeedTitle')
      }
      description={
        ready
          ? t('aiChat.onboarding.skillReadyDescription')
          : hasAnyInstalledSkill
            ? t('aiChat.onboarding.skillInstalledDescription')
            : t('aiChat.onboarding.skillNeedDescription')
      }
      ready={ready}
    />
  );
}

function DoneStep() {
  const { t } = useI18n();

  return (
    <div className="rounded-lg border border-primary/20 bg-primary/8 px-3 py-3">
      <div className="flex items-start gap-2.5">
        <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-primary" />
        <div>
          <p className="text-sm font-semibold text-ink">
            {t('aiChat.onboarding.doneTitle')}
          </p>
          <p className="mt-1 text-[12px] leading-5 text-muted">
            {t('aiChat.onboarding.doneDescription')}
          </p>
        </div>
      </div>
    </div>
  );
}

function StatusCard({
  title,
  description,
  ready,
}: {
  title: string;
  description: string;
  ready: boolean;
}) {
  return (
    <div
      className={`rounded-lg border px-3 py-3 ${
        ready
          ? 'border-primary/25 bg-primary/8'
          : 'border-hairline bg-surface-card'
      }`}
    >
      <div className="flex items-start gap-2.5">
        <CheckCircle2
          size={17}
          className={`mt-0.5 shrink-0 ${
            ready ? 'text-primary' : 'text-muted/45'
          }`}
        />
        <div>
          <p className="text-sm font-semibold text-ink">{title}</p>
          <p className="mt-1 text-[12px] leading-5 text-muted">{description}</p>
        </div>
      </div>
    </div>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <div className="flex min-h-24 items-center justify-center rounded-lg border border-hairline bg-surface-card px-3 py-5 text-[13px] text-muted">
      <Loader2 size={16} className="mr-2 animate-spin" />
      {label}
    </div>
  );
}

function AlertState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-lg border border-error/20 bg-error/8 px-3 py-3">
      <div className="flex items-start gap-2.5">
        <AlertCircle size={17} className="mt-0.5 shrink-0 text-error" />
        <div>
          <p className="text-sm font-semibold text-ink">{title}</p>
          <p className="mt-1 text-[12px] leading-5 text-muted">{description}</p>
        </div>
      </div>
    </div>
  );
}

function ModelActions({
  ready,
  loading,
  onRetry,
  onClose,
  onNext,
}: {
  ready: boolean;
  loading: boolean;
  onRetry: () => void;
  onClose: () => void;
  onNext: () => void;
}) {
  const { t } = useI18n();

  if (loading) {
    return <Button loading>{t('aiChat.onboarding.checking')}</Button>;
  }
  if (ready) {
    return (
      <div className="flex justify-end">
        <Button icon={<ArrowRight size={14} />} onClick={onNext}>
          {t('common.next')}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <Button variant="ghost" onClick={onClose}>
        {t('common.skipNow')}
      </Button>
      <Button icon={<RefreshCw size={14} />} onClick={onRetry}>
        {t('common.retryLater')}
      </Button>
    </div>
  );
}

function SkillActions({
  ready,
  loading,
  error,
  onRetry,
  onClose,
  onNext,
  onOpenSkillMarket,
}: {
  ready: boolean;
  loading: boolean;
  error: string;
  onRetry: () => void;
  onClose: () => void;
  onNext: () => void;
  onOpenSkillMarket: () => void;
}) {
  const { t } = useI18n();

  if (loading) {
    return <Button loading>{t('aiChat.onboarding.checking')}</Button>;
  }
  if (error) {
    return (
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={onClose}>
          {t('common.skipNow')}
        </Button>
        <Button icon={<RefreshCw size={14} />} onClick={onRetry}>
          {t('common.retryLater')}
        </Button>
      </div>
    );
  }
  if (ready) {
    return (
      <div className="flex justify-end">
        <Button onClick={onNext}>{t('common.done')}</Button>
      </div>
    );
  }
  return (
    <div className="flex justify-end">
      <Button icon={<Store size={14} />} onClick={onOpenSkillMarket}>
        {t('aiChat.onboarding.goSkillMarket')}
      </Button>
    </div>
  );
}
