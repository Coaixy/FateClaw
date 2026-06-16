'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';

const CONFIRM_STEP_ID = '__paipan-confirm';
const RESULT_STEP_ID = '__paipan-result';

/**
 * 手动排盘引导流中的单个步骤。
 */
export interface PaipanStep {
  id: string;
  title: string;
  description?: string;
  status?: 'complete' | 'incomplete' | 'optional';
  content: ReactNode;
}

interface PaipanStepperProps {
  steps: PaipanStep[];
  finalContent?: ReactNode;
  finalAction?: ReactNode;
  resultContent?: ReactNode;
  resultAction?: ReactNode;
  /**
   * 通知外层当前是否停在预览结果步骤，方便外层把主操作固定在弹层底部。
   */
  onResultStepChange?: (isActive: boolean) => void;
}

/**
 * 手动排盘 flow 的步骤导航容器。
 *
 * 导航按钮放在内容底部，避免用户先看到控制再填写表单；最后一步才显示外层主操作。
 */
export function PaipanStepper({
  steps,
  finalContent,
  finalAction,
  resultContent,
  resultAction,
  onResultStepChange,
}: PaipanStepperProps) {
  const { t } = useI18n();
  const visibleSteps = useMemo(() => {
    const baseSteps = steps.filter(
      (step) => step.content !== null && step.content !== undefined,
    );
    const confirmStep =
      finalContent || finalAction
        ? [
            {
              id: CONFIRM_STEP_ID,
              title: t('aiChat.paipanStepper.confirmTitle'),
              description: t('aiChat.paipanStepper.confirmDescription'),
              status: 'optional' as const,
              content: finalContent,
            },
          ]
        : [];
    const resultStep = resultContent
      ? [
            {
              id: RESULT_STEP_ID,
              title: t('aiChat.paipanStepper.resultTitle'),
              description: t('aiChat.paipanStepper.resultDescription'),
              status: 'complete' as const,
              content: resultContent,
          },
        ]
      : [];
    return [...baseSteps, ...confirmStep, ...resultStep];
  }, [finalAction, finalContent, resultContent, steps, t]);
  const [activeIndex, setActiveIndex] = useState(0);
  const hadResultContentRef = useRef(false);
  const activeStep = visibleSteps[activeIndex];
  const canGoPrevious = activeIndex > 0;
  const canGoNext = activeIndex < visibleSteps.length - 1;
  const isLastStep = !canGoNext;
  const isConfirmStep = activeStep?.id === CONFIRM_STEP_ID;
  const isResultStep = activeStep?.id === RESULT_STEP_ID;
  const hasResultContent = resultContent !== null && resultContent !== undefined;
  const showFinalAction = isConfirmStep && !hasResultContent;
  const getStepIndicatorClassName = (step: PaipanStep, index: number) => {
    const hasReachedStep = index <= activeIndex;
    const statusColor = !hasReachedStep
      ? 'bg-hairline/80'
      : step.status === 'incomplete'
        ? 'bg-rose-400/70'
        : 'bg-primary/55';

    if (index === activeIndex) {
      return `${statusColor} ring-1 ring-primary/45 ring-offset-1 ring-offset-canvas`;
    }

    return statusColor;
  };

  useEffect(() => {
    setActiveIndex((current) =>
      Math.min(current, Math.max(visibleSteps.length - 1, 0)),
    );
  }, [visibleSteps.length]);

  useEffect(() => {
    // 只在预览结果第一次出现时自动跳到结果页，避免父级重渲染后锁死步骤导航。
    if (hasResultContent && !hadResultContentRef.current) {
      setActiveIndex(Math.max(visibleSteps.length - 1, 0));
    }
    hadResultContentRef.current = hasResultContent;
  }, [hasResultContent, visibleSteps.length]);

  useEffect(() => {
    onResultStepChange?.(isResultStep);
  }, [isResultStep, onResultStepChange]);

  if (!activeStep) return null;

  return (
    <div className="space-y-3">
      {!isResultStep && (
        <div className="rounded-2xl border border-hairline bg-surface-card/45 px-3 py-3">
          <div className="min-w-0">
            <p className="text-[10px] font-medium text-muted">
              {t('aiChat.paipanStepper.progress', {
                current: activeIndex + 1,
                total: visibleSteps.length,
              })}
            </p>
            <p className="mt-1 text-[14px] font-semibold tracking-tight text-ink">
              {activeStep.title}
            </p>
            {activeStep.description && (
              <p className="mt-1 text-[11px] leading-5 text-muted">
                {activeStep.description}
              </p>
            )}
          </div>

          <div className="mt-3 flex gap-1.5">
            {visibleSteps.map((step, index) => (
              <button
                key={step.id}
                type="button"
                onClick={() => setActiveIndex(index)}
                className={`h-1.5 flex-1 rounded-full transition-colors ${getStepIndicatorClassName(step, index)}`}
                aria-label={t('aiChat.paipanStepper.jumpToStep', {
                  step: index + 1,
                  title: step.title,
                })}
              />
            ))}
          </div>

          <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-muted">
            <span className="inline-flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-primary/45" />
              {t('aiChat.paipanStepper.complete')}
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-rose-400/60" />
              {t('aiChat.paipanStepper.incomplete')}
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-hairline/80" />
              {t('aiChat.paipanStepper.notReached')}
            </span>
          </div>
        </div>
      )}

      <div className="space-y-4">
        {activeStep.content}
      </div>

      {!isResultStep && (
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
          <button
            type="button"
            onClick={() =>
              setActiveIndex((current) => Math.max(current - 1, 0))
            }
            disabled={!canGoPrevious}
            className="inline-flex h-9 items-center justify-center gap-1 rounded-xl border border-hairline bg-surface-card px-3 text-[12px] font-medium text-muted transition-colors hover:border-primary/30 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 disabled:cursor-not-allowed disabled:opacity-35 sm:rounded-lg"
          >
            <ChevronLeft size={14} />
            {t('aiChat.paipanStepper.previous')}
          </button>

          {showFinalAction ? (
            finalAction
          ) : isLastStep ? (
            isResultStep ? resultAction : null
          ) : (
            <button
              type="button"
              onClick={() =>
                setActiveIndex((current) =>
                  Math.min(current + 1, visibleSteps.length - 1),
                )
              }
              className="inline-flex h-9 items-center justify-center gap-1 rounded-xl bg-primary px-3 text-[12px] font-medium text-on-primary transition-colors hover:bg-primary-active focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 sm:rounded-lg"
            >
              {t('aiChat.paipanStepper.next')}
              <ChevronRight size={14} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
