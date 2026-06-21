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
  type WorkflowEdge,
  type WorkflowRunNode,
} from '@/features/workflows/api';
import { ApiError } from '@/lib/http/client';
import { useI18n } from '@/lib/i18n';
import { useToast } from '@/lib/use-toast';

const POLL_INTERVAL_MS = 1500;
const POLL_MAX_ATTEMPTS = 160; // ~4 分钟兜底

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type NodeStatus = 'pending' | 'running' | 'done' | 'error';

interface RunNodeState {
  node: WorkflowRunNode;
  status: NodeStatus;
  output: string;
  error?: string;
}

/**
 * 拓扑排序(Kahn);并行分支按此顺序逐个串行执行(同会话有处理锁)。
 * 入度为 0 的节点按原始顺序入队,保证确定性;有环/缺失时把剩余按原序补在末尾兜底。
 */
function topoOrder(
  nodes: WorkflowRunNode[],
  edges: WorkflowEdge[],
): WorkflowRunNode[] {
  const indegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const adjacency = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const edge of edges) {
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    adjacency.get(edge.source)?.push(edge.target);
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const queue = nodes
    .filter((n) => (indegree.get(n.id) ?? 0) === 0)
    .map((n) => n.id);
  const result: WorkflowRunNode[] = [];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (node) result.push(node);
    for (const next of adjacency.get(id) ?? []) {
      indegree.set(next, (indegree.get(next) ?? 0) - 1);
      if ((indegree.get(next) ?? 0) === 0) queue.push(next);
    }
  }
  for (const node of nodes) {
    if (!seen.has(node.id)) result.push(node);
  }
  return result;
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
  const [nodeStates, setNodeStates] = useState<RunNodeState[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [allDone, setAllDone] = useState(false);
  const [savingRefine, setSavingRefine] = useState(false);

  const sessionIdRef = useRef<string>('');
  const orderRef = useRef<WorkflowRunNode[]>([]);
  // 末端(叶)节点 id:无出边者,各自是一份成品输出。
  const leafIdsRef = useRef<Set<string>>(new Set());
  // 串行闸:一条执行链在跑时,外部触发(下一步/重跑/启动)直接忽略,避免快速双击
  // 并发自触发——排盘节点无后端处理锁,并发会落重复盘面 + 双重续跑链。
  const runningRef = useRef(false);

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

  const patchNode = useCallback((index: number, patch: Partial<RunNodeState>) => {
    setNodeStates((prev) =>
      prev.map((state, i) => (i === index ? { ...state, ...patch } : state)),
    );
  }, []);

  // 递归执行 worker(拓扑序):排盘同步、AI 发起后轮询等回复;自动节点连跑、暂停节点停下。
  // 假定调用方已持有 runningRef 闸;自动续跑在链内部递归调用自身,不重新抢闸。
  const executeFrom = useCallback(
    async (index: number) => {
      const sessionId = sessionIdRef.current;
      const order = orderRef.current;
      if (!sessionId || index >= order.length) {
        setBusy(false);
        setAllDone(true);
        return;
      }
      setCurrentIndex(index);
      setBusy(true);
      patchNode(index, { status: 'running', error: undefined });

      let exec;
      try {
        exec = await workflowsApi.runNode(workflowId, sessionId, order[index].id);
      } catch (error) {
        patchNode(index, {
          status: 'error',
          error:
            error instanceof ApiError
              ? error.message
              : t('workflows.runner.nodeError'),
        });
        setBusy(false);
        return;
      }

      if (exec.type === 'ai' && exec.assistantMessageId) {
        const reply = await waitForReply(sessionId, exec.assistantMessageId);
        if (!reply.ok) {
          patchNode(index, {
            status: 'error',
            output: reply.content,
            error: reply.content || t('workflows.runner.nodeError'),
          });
          setBusy(false);
          return;
        }
        patchNode(index, { status: 'done', output: reply.content });
      } else {
        patchNode(index, {
          status: 'done',
          output: t('workflows.runner.boardGenerated'),
        });
      }

      setBusy(false);
      if (!order[index].pauseAfter) {
        await executeFrom(index + 1);
      }
    },
    [workflowId, patchNode, t],
  );

  // 外部入口(启动/下一步/重跑):抢同步闸串行化,跑链期间的重复点击直接忽略。
  const runNode = useCallback(
    async (index: number) => {
      if (runningRef.current) return;
      runningRef.current = true;
      try {
        await executeFrom(index);
      } finally {
        runningRef.current = false;
      }
    },
    [executeFrom],
  );

  const handleStart = useCallback(async () => {
    setStarting(true);
    try {
      const res = await workflowsApi.runStart(workflowId, {
        clientId,
        input: { question: question.trim() },
      });
      sessionIdRef.current = res.session.id;
      const order = topoOrder(res.nodes, res.edges);
      orderRef.current = order;
      leafIdsRef.current = new Set(
        res.nodes
          .filter((node) => !res.edges.some((edge) => edge.source === node.id))
          .map((node) => node.id),
      );
      setNodeStates(
        order.map((node) => ({ node, status: 'pending', output: '' })),
      );
      setPhase('running');
      void runNode(0);
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
  }, [workflowId, clientId, question, runNode, t, toast]);

  const handleRefine = useCallback(
    async (index: number) => {
      const sessionId = sessionIdRef.current;
      setSavingRefine(true);
      try {
        await workflowsApi.runNodeSaveOutput(
          workflowId,
          sessionId,
          nodeStates[index].node.id,
          nodeStates[index].output,
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
    [workflowId, nodeStates, t, toast],
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

  // 跑完后的多输出:叶节点里有 AI 产出的,各自展示为一份成品。
  const leafOutputs = allDone
    ? nodeStates.filter(
        (state) =>
          leafIdsRef.current.has(state.node.id) &&
          state.node.type === 'ai' &&
          state.status === 'done' &&
          state.output.trim().length > 0,
      )
    : [];

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
          {nodeStates.map((state, index) => (
            <NodeRunCard
              key={state.node.id}
              state={state}
              index={index}
              isLeaf={leafIdsRef.current.has(state.node.id)}
              isPaused={
                index === currentIndex &&
                state.status === 'done' &&
                state.node.pauseAfter &&
                !busy &&
                !allDone
              }
              savingRefine={savingRefine}
              onEditOutput={(value) => patchNode(index, { output: value })}
              onRefine={() => handleRefine(index)}
              onRerun={() => runNode(index)}
              onNext={() => runNode(index + 1)}
            />
          ))}

          {allDone && (
            <>
              {leafOutputs.length > 0 && (
                <div className="space-y-3 rounded-2xl border border-primary/25 bg-primary/5 p-4">
                  <p className="text-[12px] font-semibold text-primary">
                    {t('workflows.runner.outputsTitle')}
                  </p>
                  {leafOutputs.map((state) => (
                    <div key={state.node.id} className="space-y-1">
                      <p className="text-[12px] font-medium text-ink">
                        {state.node.title}
                      </p>
                      <div className="whitespace-pre-wrap rounded-lg bg-surface-card px-3 py-2 text-[12px] leading-relaxed text-muted">
                        {state.output}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex flex-col items-center gap-3 rounded-2xl border border-hairline bg-surface-card py-8 text-center">
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
            </>
          )}
        </section>
      )}
    </div>
  );
}

function NodeRunCard({
  state,
  index,
  isLeaf,
  isPaused,
  savingRefine,
  onEditOutput,
  onRefine,
  onRerun,
  onNext,
}: {
  state: RunNodeState;
  index: number;
  isLeaf: boolean;
  isPaused: boolean;
  savingRefine: boolean;
  onEditOutput: (value: string) => void;
  onRefine: () => void;
  onRerun: () => void;
  onNext: () => void;
}) {
  const { t } = useI18n();
  const { node, status, output, error } = state;

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
            node.type === 'paipan'
              ? 'bg-primary/10 text-primary'
              : 'bg-success/10 text-success'
          }`}
        >
          {node.type === 'paipan'
            ? t('workflows.builder.paipanBadge')
            : t('workflows.builder.aiBadge')}
        </span>
        {isLeaf && (
          <span className="rounded-md border border-hairline px-1.5 py-0.5 text-[10px] text-muted">
            {t('workflows.runner.outputBadge')}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
          {node.title}
        </span>
        <StatusIndicator status={status} />
      </div>

      {error && <p className="mt-2 text-[12px] text-error">{error}</p>}

      {node.type === 'ai' && output && status !== 'error' && (
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
                <Button size="sm" icon={<ArrowRight size={13} />} onClick={onNext}>
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

      {/* 排盘节点暂停时也给"下一步" */}
      {node.type === 'paipan' && isPaused && (
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

function StatusIndicator({ status }: { status: NodeStatus }) {
  const { t } = useI18n();
  if (status === 'running') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-primary">
        <Loader2 size={12} className="animate-spin" />
        {t('workflows.runner.nodeRunning')}
      </span>
    );
  }
  if (status === 'done') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-success">
        <Check size={12} />
        {t('workflows.runner.nodeDone')}
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-error">
        <AlertCircle size={12} />
        {t('workflows.runner.nodeError')}
      </span>
    );
  }
  return (
    <span className="text-[11px] text-muted/70">
      {t('workflows.runner.nodePending')}
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
