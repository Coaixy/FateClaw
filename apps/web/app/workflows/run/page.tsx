'use client';

import {
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  AlertCircle,
  ArrowRight,
  Check,
  Loader2,
  MessageSquare,
  Play,
  RefreshCw,
  Save,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { chatSessionsApi } from '@/features/chat/api';
import {
  workflowsApi,
  type WorkflowDefinition,
  type WorkflowRunStep,
} from '@/features/workflows/api';
import { ApiError } from '@/lib/http/client';
import { useI18n } from '@/lib/i18n';
import { useToast } from '@/lib/use-toast';

const POLL_INTERVAL_MS = 1500;
const POLL_MAX_ATTEMPTS = 160; // ~4 分钟兜底

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type StepStatus = 'pending' | 'running' | 'done' | 'error';

interface RunStepState {
  step: WorkflowRunStep;
  status: StepStatus;
  output: string;
  error?: string;
}

/**
 * 轮询会话消息,等某条 AI 回复落库完成。
 *
 * @remarks 主路径按 execute 返回的 assistantMessageId 命中并看 metadata.kind;
 *          兜底:processing 转 false 后取最新的 final/error 机器人消息。
 */
async function waitForReply(
  sessionId: string,
  messageId: string,
): Promise<{ ok: boolean; content: string }> {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt += 1) {
    let res;
    try {
      res = await chatSessionsApi.messages(sessionId);
    } catch {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    const byId = res.messages.find((message) => message.id === messageId);
    if (byId) {
      const kind = byId.metadata?.kind;
      if (kind === 'final') return { ok: true, content: byId.content };
      if (kind === 'error') return { ok: false, content: byId.content };
    }
    if (!res.processing) {
      const finals = res.messages.filter(
        (message) =>
          message.is_bot_message &&
          (message.metadata?.kind === 'final' ||
            message.metadata?.kind === 'error'),
      );
      if (finals.length > 0) {
        const latest = finals.reduce((a, b) =>
          a.timestamp >= b.timestamp ? a : b,
        );
        return {
          ok: latest.metadata?.kind !== 'error',
          content: latest.content,
        };
      }
      if (byId) return { ok: true, content: byId.content };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { ok: false, content: '' };
}

function RunWorkflowInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { t } = useI18n();
  const { toast } = useToast();

  const workflowId = params.get('id') ?? '';
  const clientId = params.get('client') ?? undefined;

  const [phase, setPhase] = useState<
    'loading' | 'start' | 'running' | 'notfound'
  >('loading');
  const [workflow, setWorkflow] = useState<WorkflowDefinition | null>(null);
  const [question, setQuestion] = useState('');
  const [starting, setStarting] = useState(false);
  const [stepStates, setStepStates] = useState<RunStepState[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [allDone, setAllDone] = useState(false);
  const [savingRefine, setSavingRefine] = useState(false);

  const sessionIdRef = useRef<string>('');
  const stepsRef = useRef<WorkflowRunStep[]>([]);

  useEffect(() => {
    if (!workflowId) {
      setPhase('notfound');
      return;
    }
    let cancelled = false;
    workflowsApi
      .get(workflowId)
      .then((data) => {
        if (cancelled) return;
        setWorkflow(data);
        setPhase('start');
      })
      .catch(() => {
        if (!cancelled) setPhase('notfound');
      });
    return () => {
      cancelled = true;
    };
  }, [workflowId]);

  const patchStep = useCallback((index: number, patch: Partial<RunStepState>) => {
    setStepStates((prev) =>
      prev.map((state, i) => (i === index ? { ...state, ...patch } : state)),
    );
  }, []);

  // 执行第 index 步:排盘步同步、AI 步发起后轮询等回复;自动步连跑、暂停步停下。
  const runStep = useCallback(
    async (index: number) => {
      const sessionId = sessionIdRef.current;
      const steps = stepsRef.current;
      if (!sessionId || index >= steps.length) {
        setBusy(false);
        setAllDone(true);
        return;
      }
      setCurrentIndex(index);
      setBusy(true);
      patchStep(index, { status: 'running', error: undefined });

      let exec;
      try {
        exec = await workflowsApi.runStep(workflowId, sessionId, steps[index].id);
      } catch (error) {
        patchStep(index, {
          status: 'error',
          error:
            error instanceof ApiError
              ? error.message
              : t('workflows.runner.stepError'),
        });
        setBusy(false);
        return;
      }

      if (exec.type === 'ai' && exec.assistantMessageId) {
        const reply = await waitForReply(sessionId, exec.assistantMessageId);
        if (!reply.ok) {
          patchStep(index, {
            status: 'error',
            output: reply.content,
            error: reply.content || t('workflows.runner.stepError'),
          });
          setBusy(false);
          return;
        }
        patchStep(index, { status: 'done', output: reply.content });
      } else {
        patchStep(index, {
          status: 'done',
          output: t('workflows.runner.boardGenerated'),
        });
      }

      setBusy(false);
      if (!steps[index].pauseAfter) {
        await runStep(index + 1);
      }
    },
    [workflowId, patchStep, t],
  );

  const handleStart = useCallback(async () => {
    setStarting(true);
    try {
      const res = await workflowsApi.runStart(workflowId, {
        clientId,
        input: { question: question.trim() },
      });
      sessionIdRef.current = res.session.id;
      stepsRef.current = res.steps;
      setStepStates(
        res.steps.map((step) => ({ step, status: 'pending', output: '' })),
      );
      setPhase('running');
      void runStep(0);
    } catch (error) {
      toast(
        'error',
        error instanceof ApiError
          ? error.message
          : t('workflows.runner.startError'),
      );
    } finally {
      setStarting(false);
    }
  }, [workflowId, clientId, question, runStep, t, toast]);

  const handleRefine = useCallback(
    async (index: number) => {
      const sessionId = sessionIdRef.current;
      setSavingRefine(true);
      try {
        await workflowsApi.runStepSaveOutput(
          workflowId,
          sessionId,
          stepStates[index].step.id,
          stepStates[index].output,
        );
        toast('success', t('workflows.runner.refined'));
      } catch (error) {
        toast(
          'error',
          error instanceof ApiError ? error.message : t('workflows.loadError'),
        );
      } finally {
        setSavingRefine(false);
      }
    },
    [workflowId, stepStates, t, toast],
  );

  if (phase === 'loading') {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted" />
      </div>
    );
  }

  if (phase === 'notfound' || !workflow) {
    return (
      <div className="mx-auto max-w-2xl py-16 text-center text-sm text-muted">
        {t('workflows.notFound')}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-ink">
          {workflow.name}
        </h1>
        <p className="mt-1 text-sm text-muted">{t('workflows.runner.title')}</p>
      </header>

      {phase === 'start' ? (
        <section className="space-y-4 rounded-2xl border border-hairline bg-surface-card p-5">
          <label className="block space-y-1.5">
            <span className="text-[12px] font-medium text-muted">
              {t('workflows.runner.questionLabel')}
            </span>
            <textarea
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder={t('workflows.runner.questionPlaceholder')}
              rows={3}
              className="w-full resize-none rounded-lg border border-hairline bg-canvas px-3 py-2 text-[13px] text-ink placeholder:text-muted focus:border-primary focus:outline-none"
            />
          </label>
          <Button
            onClick={handleStart}
            loading={starting}
            icon={<Play size={15} />}
          >
            {t('workflows.runner.start')}
          </Button>
        </section>
      ) : (
        <section className="space-y-3">
          {stepStates.map((state, index) => (
            <StepRunCard
              key={state.step.id}
              state={state}
              index={index}
              isPaused={
                index === currentIndex &&
                state.status === 'done' &&
                state.step.pauseAfter &&
                !busy &&
                !allDone
              }
              savingRefine={savingRefine}
              onEditOutput={(value) => patchStep(index, { output: value })}
              onRefine={() => handleRefine(index)}
              onRerun={() => runStep(index)}
              onNext={() => runStep(index + 1)}
            />
          ))}

          {allDone && (
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-primary/25 bg-primary/5 py-8 text-center">
              <Check className="h-6 w-6 text-primary" />
              <p className="text-sm font-medium text-ink">
                {t('workflows.runner.allDone')}
              </p>
              <Button
                variant="secondary"
                icon={<MessageSquare size={14} />}
                onClick={() =>
                  router.push(
                    `/ai-chat?sid=${encodeURIComponent(sessionIdRef.current)}`,
                  )
                }
              >
                {t('workflows.runner.goToSession')}
              </Button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function StepRunCard({
  state,
  index,
  isPaused,
  savingRefine,
  onEditOutput,
  onRefine,
  onRerun,
  onNext,
}: {
  state: RunStepState;
  index: number;
  isPaused: boolean;
  savingRefine: boolean;
  onEditOutput: (value: string) => void;
  onRefine: () => void;
  onRerun: () => void;
  onNext: () => void;
}) {
  const { t } = useI18n();
  const { step, status, output, error } = state;

  return (
    <div
      className={`rounded-2xl border bg-surface-card p-4 ${
        status === 'error' ? 'border-error/30' : 'border-hairline'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
          {index + 1}
        </span>
        <span
          className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${
            step.type === 'paipan'
              ? 'bg-primary/10 text-primary'
              : 'bg-success/10 text-success'
          }`}
        >
          {step.type === 'paipan'
            ? t('workflows.builder.paipanBadge')
            : t('workflows.builder.aiBadge')}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
          {step.title}
        </span>
        <StatusIndicator status={status} />
      </div>

      {error && (
        <p className="mt-2 text-[12px] text-error">{error}</p>
      )}

      {step.type === 'ai' && output && status !== 'error' && (
        <div className="mt-3">
          {isPaused ? (
            <>
              <textarea
                value={output}
                onChange={(event) => onEditOutput(event.target.value)}
                rows={6}
                className="w-full resize-y rounded-lg border border-hairline bg-canvas px-3 py-2 text-[13px] leading-relaxed text-ink focus:border-primary focus:outline-none"
              />
              <p className="mt-1 text-[11px] text-muted/80">
                {t('workflows.runner.refinePlaceholder')}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Save size={13} />}
                  loading={savingRefine}
                  onClick={onRefine}
                >
                  {t('workflows.runner.refineSave')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<RefreshCw size={13} />}
                  onClick={onRerun}
                >
                  {t('workflows.runner.rerun')}
                </Button>
                <Button
                  size="sm"
                  icon={<ArrowRight size={13} />}
                  onClick={onNext}
                >
                  {t('workflows.runner.next')}
                </Button>
              </div>
            </>
          ) : (
            <div className="whitespace-pre-wrap rounded-lg bg-canvas px-3 py-2 text-[12px] leading-relaxed text-muted">
              {output}
            </div>
          )}
        </div>
      )}

      {/* 排盘步暂停时也给"下一步" */}
      {step.type === 'paipan' && isPaused && (
        <div className="mt-3 flex items-center gap-2">
          <span className="text-[12px] text-muted">
            {t('workflows.runner.boardGenerated')}
          </span>
          <Button size="sm" icon={<ArrowRight size={13} />} onClick={onNext}>
            {t('workflows.runner.next')}
          </Button>
        </div>
      )}
    </div>
  );
}

function StatusIndicator({ status }: { status: StepStatus }) {
  const { t } = useI18n();
  if (status === 'running') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-primary">
        <Loader2 size={12} className="animate-spin" />
        {t('workflows.runner.stepRunning')}
      </span>
    );
  }
  if (status === 'done') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-success">
        <Check size={12} />
        {t('workflows.runner.stepDone')}
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-error">
        <AlertCircle size={12} />
        {t('workflows.runner.stepError')}
      </span>
    );
  }
  return (
    <span className="text-[11px] text-muted/70">
      {t('workflows.runner.stepPending')}
    </span>
  );
}

export default function RunWorkflowPage() {
  return (
    <AppShell>
      <Suspense
        fallback={
          <div className="flex min-h-[40vh] items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted" />
          </div>
        }
      >
        <RunWorkflowInner />
      </Suspense>
    </AppShell>
  );
}
