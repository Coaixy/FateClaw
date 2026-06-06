'use client';

import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Settings2,
  Sparkles,
  Store,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { OnboardingGuideStep } from '@/components/ai-chat/use-onboarding-guide-status';

interface OnboardingGuideDialogProps {
  open: boolean;
  step: OnboardingGuideStep;
  modelReady: boolean;
  skillReady: boolean;
  modelLoading: boolean;
  skillLoading: boolean;
  modelError: string;
  skillError: string;
  availableOfficialModelCount: number;
  hasAnyInstalledSkill: boolean;
  onClose: () => void;
  onSaveStep: (step: OnboardingGuideStep) => void;
  onRetry: () => void;
  onOpenModelSettings: () => void;
  onOpenSkillMarket: () => void;
  onComplete: () => void;
}

const steps: Array<{ key: OnboardingGuideStep; label: string }> = [
  { key: 'welcome', label: '欢迎' },
  { key: 'model', label: '官方模型' },
  { key: 'skill', label: 'Skill' },
  { key: 'done', label: '完成' },
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
        <div className="overflow-hidden rounded-lg border border-hairline bg-canvas shadow-2xl shadow-ink/20">
          <div className="border-b border-hairline px-4 py-4 sm:px-5">
            <div className="flex items-start gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Sparkles size={18} aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted">
                  AI Chat Guide
                </p>
                <h1
                  id="ai-chat-onboarding-title"
                  className="mt-1 text-lg font-semibold leading-tight text-ink sm:text-xl"
                >
                  {props.step === 'welcome'
                    ? '启动 AI Chat'
                    : props.step === 'model'
                      ? '选择官方模型'
                      : props.step === 'skill'
                        ? '启用一个 Skill'
                        : '可以开始提问了'}
                </h1>
              </div>
              <button
                type="button"
                aria-label="关闭启动向导"
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
                    {item.label}
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
                availableOfficialModelCount={props.availableOfficialModelCount}
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
                  稍后再说
                </Button>
                <Button
                  icon={<ArrowRight size={14} />}
                  onClick={goNextFromWelcome}
                >
                  开始配置
                </Button>
              </div>
            ) : props.step === 'model' ? (
              <ModelActions
                ready={props.modelReady}
                loading={props.modelLoading}
                error={props.modelError}
                availableOfficialModelCount={props.availableOfficialModelCount}
                onRetry={props.onRetry}
                onClose={props.onClose}
                onNext={goNextFromModel}
                onOpenModelSettings={props.onOpenModelSettings}
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
                <Button onClick={props.onComplete}>开始提问</Button>
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
  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-6 text-body">
        完成两个前置项后，就能在 AI Chat 里稳定开始对话：先选择官方模型，再启用一个可用于对话的 Skill。
      </p>
      <div className="grid gap-2">
        <StatusCard
          title="官方模型"
          description="使用平台维护的官方模型，不需要填写自备 API Key。"
          ready={modelReady}
        />
        <StatusCard
          title="Skill"
          description="从技能市场订阅并启用至少一个 Skill。"
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
  availableOfficialModelCount,
}: {
  ready: boolean;
  loading: boolean;
  error: string;
  availableOfficialModelCount: number;
}) {
  if (loading) {
    return <LoadingState label="正在读取官方模型状态..." />;
  }

  if (error) {
    return (
      <AlertState
        title="暂时无法读取官方模型"
        description={error}
      />
    );
  }

  if (ready) {
    return (
      <StatusCard
        title="模型已就绪"
        description="当前账号已经有可用于对话的模型，可以继续配置 Skill。"
        ready={ready}
      />
    );
  }

  if (availableOfficialModelCount === 0) {
    return (
      <AlertState
        title="当前暂无可用官方模型"
        description="管理员还没有配置可用于对话的官方模型，请稍后再试或联系管理员。"
      />
    );
  }

  return (
    <StatusCard
      title="还需要选择官方模型"
      description={`当前有 ${availableOfficialModelCount} 个官方模型可用，请去模型设置页选择一个。`}
      ready={false}
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
  if (loading) {
    return <LoadingState label="正在检查已启用 Skill..." />;
  }

  if (error) {
    return (
      <AlertState
        title="Skill 市场暂时不可用"
        description={error}
      />
    );
  }

  return (
    <StatusCard
      title={ready ? 'Skill 已启用' : '还需要启用一个 Skill'}
      description={
        ready
          ? '当前账号已经有可用于 AI Chat 的 Skill。'
          : hasAnyInstalledSkill
            ? '你已经安装了 Skill，但需要启用后才会进入对话链路。'
            : '去技能市场挑选并订阅一个 Skill，订阅成功后回到 AI Chat 继续。'
      }
      ready={ready}
    />
  );
}

function DoneStep() {
  return (
    <div className="rounded-lg border border-primary/20 bg-primary/8 px-3 py-3">
      <div className="flex items-start gap-2.5">
        <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-primary" />
        <div>
          <p className="text-sm font-semibold text-ink">启动配置已完成</p>
          <p className="mt-1 text-[12px] leading-5 text-muted">
            官方模型和 Skill 都已准备好。关闭向导后，可以直接在输入框里开始第一次提问。
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
          <p className="mt-1 text-[12px] leading-5 text-muted">
            {description}
          </p>
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
          <p className="mt-1 text-[12px] leading-5 text-muted">
            {description}
          </p>
        </div>
      </div>
    </div>
  );
}

function ModelActions({
  ready,
  loading,
  error,
  availableOfficialModelCount,
  onRetry,
  onClose,
  onNext,
  onOpenModelSettings,
}: {
  ready: boolean;
  loading: boolean;
  error: string;
  availableOfficialModelCount: number;
  onRetry: () => void;
  onClose: () => void;
  onNext: () => void;
  onOpenModelSettings: () => void;
}) {
  if (loading) {
    return <Button loading>检查中</Button>;
  }
  if (ready) {
    return (
      <div className="flex justify-end">
        <Button icon={<ArrowRight size={14} />} onClick={onNext}>
          下一步
        </Button>
      </div>
    );
  }
  if (error || availableOfficialModelCount === 0) {
    return (
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={onClose}>
          跳过本次
        </Button>
        <Button icon={<RefreshCw size={14} />} onClick={onRetry}>
          稍后重试
        </Button>
      </div>
    );
  }
  return (
    <div className="flex justify-end">
      <Button icon={<Settings2 size={14} />} onClick={onOpenModelSettings}>
        去选择官方模型
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
  if (loading) {
    return <Button loading>检查中</Button>;
  }
  if (error) {
    return (
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={onClose}>
          跳过本次
        </Button>
        <Button icon={<RefreshCw size={14} />} onClick={onRetry}>
          稍后重试
        </Button>
      </div>
    );
  }
  if (ready) {
    return (
      <div className="flex justify-end">
        <Button onClick={onNext}>完成</Button>
      </div>
    );
  }
  return (
    <div className="flex justify-end">
      <Button icon={<Store size={14} />} onClick={onOpenSkillMarket}>
        去 Skill 市场
      </Button>
    </div>
  );
}
