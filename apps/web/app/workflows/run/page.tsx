'use client';

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import {
  AlertCircle,
  ArrowRight,
  Check,
  Compass,
  Loader2,
  MessageSquare,
  Play,
  RefreshCw,
  Save,
  SkipForward,
  Sparkles,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { ArtifactRenderer } from '@/components/chat/artifact-renderer';
import { parseToolContext } from '@/features/chat/api';
import {
  paipanApi,
  type PaipanCatalogItem,
  type PaipanCommitResponse,
} from '@/features/paipan/api';
import {
  workflowsApi,
  type WorkflowDefinition,
  type WorkflowRunInput,
  type WorkflowRunNodeState,
  type WorkflowRunState,
} from '@/features/workflows/api';
import { resolveNodePositions } from '@/features/workflows/layout';
import { ApiError } from '@/lib/http/client';
import { useI18n } from '@/lib/i18n';
import { useToast } from '@/lib/use-toast';

// 复用"直接对话"的排盘表单:排盘节点待起盘时弹出,卦师当场填参出盘到本次运行会话。
const PaipanSheet = dynamic(
  () =>
    import('@/components/ai-chat/paipan-sheet').then(
      (module) => module.PaipanSheet,
    ),
  { ssr: false },
);

/** 运行中(status='running')时轮询后端快照的间隔。 */
const POLL_INTERVAL_MS = 1500;

/** 后端节点状态(对齐契约 WorkflowRunNodeStatus)。 */
type RunNodeStatus = WorkflowRunNodeState['status'];

/** 已满足/完成(进度计数 + 下游放行视角)。 */
const DONE_STATUSES: ReadonlySet<RunNodeStatus> = new Set([
  'done',
  'manual',
  'skipped',
]);

// 画布运行态节点 data(满足 React Flow v12 的 Node data 约束)。
type RunNodeData = {
  title: string;
  kind: 'paipan' | 'ai';
  status: RunNodeStatus;
  selected: boolean;
};
type RunFlowNode = Node<RunNodeData>;

function statusIcon(status: RunNodeStatus) {
  if (status === 'running' || status === 'awaiting_paipan') {
    return <Loader2 size={12} className="animate-spin text-primary" />;
  }
  if (status === 'done' || status === 'manual') {
    return <Check size={12} className="text-emerald-500" />;
  }
  if (status === 'error') {
    return <AlertCircle size={12} className="text-error" />;
  }
  if (status === 'skipped') {
    return <SkipForward size={12} className="text-muted/70" />;
  }
  return <span className="h-2 w-2 rounded-full bg-hairline" />;
}

/** 画布上的运行态节点卡片。 */
function RunFlowNodeView({ data }: NodeProps) {
  const d = data as RunNodeData;
  const ring = d.selected
    ? 'border-primary ring-2 ring-primary/30'
    : d.status === 'error'
      ? 'border-error/50'
      : d.status === 'running' || d.status === 'awaiting_paipan'
        ? 'border-primary'
        : d.status === 'done' || d.status === 'manual'
          ? 'border-emerald-500/50'
          : 'border-hairline';
  return (
    <div
      className={`min-w-[150px] rounded-xl border bg-surface-card px-3 py-2 shadow-sm transition-colors ${ring}`}
    >
      <Handle type="target" position={Position.Left} className="!opacity-0" />
      <div className="flex items-center gap-1.5">
        {d.kind === 'paipan' ? (
          <Compass size={13} className="text-primary" />
        ) : (
          <Sparkles size={13} className="text-success" />
        )}
        <span className="truncate text-[12px] font-medium text-ink">
          {d.title}
        </span>
        <span className="ml-auto flex items-center">{statusIcon(d.status)}</span>
      </div>
      <Handle type="source" position={Position.Right} className="!opacity-0" />
    </div>
  );
}

const inputClass =
  'w-full rounded-lg border border-hairline bg-surface-card px-3 py-2 text-[13px] text-ink outline-none focus:border-primary';

/** 运行前输入表单(沿用定义里的 inputs;为空时回退单个 question 框)。 */
function RunStartForm({
  inputs,
  values,
  onChange,
  onStart,
  busy,
  t,
}: {
  inputs: WorkflowRunInput[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  onStart: () => void;
  busy: boolean;
  t: (key: string) => string;
}) {
  return (
    <div className="mx-auto max-w-xl space-y-4 rounded-2xl border border-hairline bg-surface-card p-6">
      <h2 className="text-lg font-semibold text-ink">
        {t('workflows.runner.title')}
      </h2>
      {inputs.map((input) => (
        <div key={input.key} className="space-y-1.5">
          <label className="text-[13px] font-medium text-body">
            {input.label}
            {input.required && <span className="ml-0.5 text-error">*</span>}
          </label>
          {input.type === 'textarea' ? (
            <textarea
              className={`${inputClass} min-h-[96px] resize-y`}
              value={values[input.key] ?? ''}
              onChange={(event) => onChange(input.key, event.target.value)}
            />
          ) : (
            <input
              className={inputClass}
              value={values[input.key] ?? ''}
              onChange={(event) => onChange(input.key, event.target.value)}
            />
          )}
        </div>
      ))}
      <Button onClick={onStart} disabled={busy} className="w-full gap-1.5">
        {busy ? (
          <Loader2 size={15} className="animate-spin" />
        ) : (
          <Play size={15} />
        )}
        {t('workflows.start')}
      </Button>
    </div>
  );
}

/** 选中节点的详情面板:展示产出/盘面/错误 + 起盘/重跑/跳过/手填润色等操作。 */
function NodeDetailPanel({
  node,
  draft,
  onDraftChange,
  onCast,
  onRerun,
  onSkip,
  onSaveOutput,
  savingOutput,
  busy,
  t,
}: {
  node: WorkflowRunNodeState;
  draft: string;
  onDraftChange: (value: string) => void;
  onCast: () => void;
  onRerun: () => void;
  onSkip: () => void;
  onSaveOutput: () => void;
  savingOutput: boolean;
  busy: boolean;
  t: (key: string) => string;
}) {
  const artifacts = parseToolContext(node.toolContext ?? null);
  const isPaipan = node.type === 'paipan';
  const isError = node.status === 'error';
  const isDoneLike = node.status === 'done' || node.status === 'manual';
  const isAwaitingPaipan = node.status === 'awaiting_paipan';
  // 文本产出可编辑场景:AI/手填节点已完成(润色),或任意节点出错后手填补救。
  const editable = (!isPaipan && isDoneLike) || isError;

  return (
    <div className="space-y-3 rounded-2xl border border-hairline bg-surface-card p-4">
      <div className="flex items-center gap-1.5">
        {isPaipan ? (
          <Compass size={14} className="text-primary" />
        ) : (
          <Sparkles size={14} className="text-success" />
        )}
        <span className="text-sm font-semibold text-ink">{node.title}</span>
        <span className="ml-auto">{statusIcon(node.status)}</span>
      </div>

      {isError && node.error && (
        <p className="rounded-lg bg-error/10 px-3 py-2 text-[12px] text-error">
          {node.error}
        </p>
      )}

      {artifacts.length > 0 && <ArtifactRenderer entries={artifacts} />}

      {!isPaipan && (isDoneLike || isError) && (
        <textarea
          className={`${inputClass} min-h-[140px] resize-y`}
          value={draft}
          placeholder={
            isError
              ? t('workflows.runner.manualFillPlaceholder')
              : t('workflows.runner.refinePlaceholder')
          }
          onChange={(event) => onDraftChange(event.target.value)}
        />
      )}
      {isPaipan && isDoneLike && (
        <p className="text-[12px] text-muted">
          {t('workflows.runner.boardGenerated')}
        </p>
      )}

      {/* 操作区 */}
      <div className="flex flex-wrap gap-2">
        {isAwaitingPaipan && (
          <Button onClick={onCast} disabled={busy} className="gap-1.5">
            <Compass size={14} /> {t('workflows.runner.castBoard')}
          </Button>
        )}
        {isError && isPaipan && (
          <Button onClick={onCast} disabled={busy} variant="secondary" className="gap-1.5">
            <Compass size={14} /> {t('workflows.runner.retryCast')}
          </Button>
        )}
        {editable && (
          <Button
            onClick={onSaveOutput}
            disabled={savingOutput || busy || !draft.trim()}
            variant="secondary"
            className="gap-1.5"
          >
            {savingOutput ? (
              <Loader2 size={14} className="animate-spin" />
            ) : isError ? (
              <Check size={14} />
            ) : (
              <Save size={14} />
            )}
            {isError
              ? t('workflows.runner.manualFill')
              : t('workflows.runner.refineSave')}
          </Button>
        )}
        {isError && (
          <Button onClick={onSkip} disabled={busy} variant="ghost" className="gap-1.5">
            <SkipForward size={14} /> {t('workflows.runner.skip')}
          </Button>
        )}
        {(isDoneLike || isError) && !isAwaitingPaipan && (
          <Button onClick={onRerun} disabled={busy} variant="ghost" className="gap-1.5">
            <RefreshCw size={14} /> {t('workflows.runner.rerunFromHere')}
          </Button>
        )}
      </div>
      {node.status === 'running' && (
        <p className="flex items-center gap-1.5 text-[12px] text-muted">
          <Loader2 size={12} className="animate-spin" />
          {node.progressText || t('workflows.runner.nodeRunning')}
        </p>
      )}
    </div>
  );
}

function RunWorkflowInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { t } = useI18n();
  const { toast } = useToast();

  const workflowId = params.get('id') ?? '';
  const clientId = params.get('client') ?? undefined;
  const runIdParam = params.get('run') ?? '';

  const [phase, setPhase] = useState<'loading' | 'start' | 'running' | 'notfound'>(
    'loading',
  );
  const [workflow, setWorkflow] = useState<WorkflowDefinition | null>(null);
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [runState, setRunState] = useState<WorkflowRunState | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [paipanSheet, setPaipanSheet] = useState<{
    nodeId: string;
    skill: string;
  } | null>(null);
  const [catalog, setCatalog] = useState<PaipanCatalogItem[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [savingOutput, setSavingOutput] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // 自动弹排盘:卦师取消过的排盘节点不再自动重弹(防无限重弹);本次提交是否成功(onClose 据此判断是否记取消)。
  const dismissedPaipanRef = useRef<Set<string>>(new Set());
  const committedRef = useRef(false);

  // 运行前输入项:定义为空时回退单个 question 框(向后兼容)。
  const effectiveInputs: WorkflowRunInput[] = useMemo(() => {
    if (!workflow) return [];
    if (workflow.inputs.length > 0) return workflow.inputs;
    return [
      {
        key: 'question',
        label: t('workflows.runner.questionLabel'),
        type: 'textarea',
        required: true,
      },
    ];
  }, [workflow, t]);

  // 加载定义(画布坐标/输入/排盘术数);带 ?run= 则加载该运行,否则进入起始表单。
  useEffect(() => {
    if (!workflowId) {
      setPhase('notfound');
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const def = await workflowsApi.get(workflowId);
        if (cancelled) return;
        setWorkflow(def);
        if (runIdParam) {
          const state = await workflowsApi.run.get(runIdParam);
          if (cancelled) return;
          setRunState(state);
          setPhase('running');
        } else {
          setPhase('start');
        }
      } catch {
        if (!cancelled) setPhase('notfound');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workflowId, runIdParam]);

  // 排盘目录(PaipanSheet 用)挂载时加载一次。注意:不能把 catalogLoading 放进依赖 —— effect 内
  // setCatalogLoading(true) 会触发 effect 重跑,其 cleanup 把进行中的请求 cancel 掉,导致 .then/.finally
  // 被 if(!cancelled) 挡掉 → catalog 永远没设、loading 永远卡住。用 [] 依赖挂载一次即可。
  useEffect(() => {
    let cancelled = false;
    setCatalogLoading(true);
    void paipanApi
      .catalog()
      .then((items) => {
        if (!cancelled) setCatalog(items);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setCatalogLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 运行中轮询后端快照:仅 status='running' 时拉,转入 paused/done/error 即停。
  useEffect(() => {
    if (phase !== 'running' || !runState || runState.status !== 'running') return;
    const runId = runState.runId;
    let cancelled = false;
    const timer = setInterval(() => {
      void workflowsApi.run
        .get(runId)
        .then((state) => {
          if (!cancelled) setRunState(state);
        })
        .catch(() => {});
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [phase, runState?.status, runState?.runId]);

  const handleInputChange = useCallback((key: string, value: string) => {
    setInputValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleStart = useCallback(async () => {
    for (const input of effectiveInputs) {
      if (input.required && !(inputValues[input.key] ?? '').trim()) {
        toast('error', t('workflows.runner.inputRequiredError'));
        return;
      }
    }
    setBusy(true);
    try {
      const state = await workflowsApi.run.start(workflowId, {
        clientId,
        input: inputValues,
      });
      setRunState(state);
      setPhase('running');
      router.replace(
        `/workflows/run?id=${encodeURIComponent(workflowId)}&run=${encodeURIComponent(state.runId)}`,
      );
    } catch (error) {
      toast(
        'error',
        error instanceof ApiError
          ? error.message
          : t('workflows.runner.startError'),
      );
    } finally {
      setBusy(false);
    }
  }, [effectiveInputs, inputValues, workflowId, clientId, router, t, toast]);

  /** 统一执行一个会改运行状态的操作(rerun/skip/resume/saveOutput/commitPaipan),回灌快照。 */
  const runAction = useCallback(
    async (
      action: () => Promise<WorkflowRunState>,
      errorTitleKey = 'workflows.runner.nodeError',
    ): Promise<boolean> => {
      setBusy(true);
      try {
        const state = await action();
        setRunState(state);
        return true;
      } catch (error) {
        toast(
          'error',
          error instanceof ApiError ? error.message : t(errorTitleKey),
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [t, toast],
  );

  const openPaipan = useCallback(
    (nodeId: string) => {
      const node = workflow?.graph.nodes.find((item) => item.id === nodeId);
      if (!node || node.type !== 'paipan') return;
      committedRef.current = false;
      setPaipanSheet({ nodeId, skill: node.skill });
    },
    [workflow],
  );

  // 排盘节点进入 awaiting_paipan 时自动弹 PaipanSheet(沿用旧版自动弹体验);
  // 卦师取消过的不再自动重弹;提交后该节点变 done、自动弹下一个待起盘节点。
  useEffect(() => {
    if (phase !== 'running' || paipanSheet || !runState) return;
    const awaiting = runState.nodes.find(
      (node) =>
        node.status === 'awaiting_paipan' &&
        !dismissedPaipanRef.current.has(node.nodeId),
    );
    if (awaiting) {
      setSelectedNodeId(awaiting.nodeId);
      openPaipan(awaiting.nodeId);
    }
  }, [phase, runState, paipanSheet, openPaipan]);

  // PaipanSheet 自落盘面后:把盘面 id 认领给排盘节点并推进。
  const handlePaipanCommitted = useCallback(
    async (result: PaipanCommitResponse) => {
      if (!runState || !paipanSheet) return;
      const ok = await runAction(() =>
        workflowsApi.run.commitPaipan(
          runState.runId,
          paipanSheet.nodeId,
          result.resultMessage.id,
        ),
      );
      // 提交成功:标记本次为已提交,onClose 不记取消(节点也已变 done,不会再自动重弹)。
      if (ok) committedRef.current = true;
    },
    [runState, paipanSheet, runAction],
  );

  const handleResume = useCallback(() => {
    if (!runState) return;
    void runAction(() => workflowsApi.run.resume(runState.runId));
  }, [runState, runAction]);

  const handleRerun = useCallback(
    (nodeId: string) => {
      if (!runState) return;
      void runAction(() => workflowsApi.run.rerun(runState.runId, nodeId));
    },
    [runState, runAction],
  );

  const handleSkip = useCallback(
    (nodeId: string) => {
      if (!runState) return;
      void runAction(() => workflowsApi.run.skip(runState.runId, nodeId));
    },
    [runState, runAction],
  );

  const handleSaveOutput = useCallback(
    async (nodeId: string) => {
      if (!runState) return;
      const content = drafts[nodeId] ?? '';
      setSavingOutput(true);
      const ok = await runAction(
        () => workflowsApi.run.saveOutput(runState.runId, nodeId, content),
        'workflows.runner.nodeError',
      );
      setSavingOutput(false);
      if (ok) {
        toast('success', t('workflows.runner.refined'));
      }
    },
    [runState, drafts, runAction, t, toast],
  );

  const positions = useMemo(
    () => (workflow ? resolveNodePositions(workflow.graph) : {}),
    [workflow],
  );

  const rfNodes: RunFlowNode[] = useMemo(
    () =>
      (runState?.nodes ?? []).map((node) => ({
        id: node.nodeId,
        type: 'run',
        position: positions[node.nodeId] ?? { x: 0, y: 0 },
        data: {
          title: node.title,
          kind: node.type,
          status: node.status,
          selected: node.nodeId === selectedNodeId,
        },
      })),
    [runState?.nodes, positions, selectedNodeId],
  );

  const rfEdges: Edge[] = useMemo(
    () =>
      (runState?.edges ?? []).map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        markerEnd: { type: MarkerType.ArrowClosed },
      })),
    [runState?.edges],
  );

  const nodeTypes = useMemo(() => ({ run: RunFlowNodeView }), []);

  const selectedNode = useMemo(
    () => runState?.nodes.find((node) => node.nodeId === selectedNodeId) ?? null,
    [runState?.nodes, selectedNodeId],
  );

  // 末端叶节点(无出边)的已完成产出 = 本次运行成品。
  const leafOutputs = useMemo(() => {
    if (!runState) return [];
    return runState.nodes.filter(
      (node) =>
        DONE_STATUSES.has(node.status) &&
        node.type === 'ai' &&
        !runState.edges.some((edge) => edge.source === node.nodeId),
    );
  }, [runState]);

  const progress = useMemo(() => {
    const nodes = runState?.nodes ?? [];
    const done = nodes.filter((node) => DONE_STATUSES.has(node.status)).length;
    return { done, total: nodes.length };
  }, [runState?.nodes]);

  if (phase === 'loading') {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Loader2 className="animate-spin text-muted" />
      </div>
    );
  }

  if (phase === 'notfound') {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-[13px] text-muted">
        {t('workflows.notFound')}
      </div>
    );
  }

  if (phase === 'start') {
    return (
      <div className="space-y-4">
        <header>
          <h1 className="text-2xl font-bold tracking-tight text-ink">
            {workflow?.name}
          </h1>
        </header>
        <RunStartForm
          inputs={effectiveInputs}
          values={inputValues}
          onChange={handleInputChange}
          onStart={handleStart}
          busy={busy}
          t={t}
        />
      </div>
    );
  }

  // phase === 'running'
  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight text-ink">
          {runState?.title || workflow?.name}
        </h1>
        <span className="text-[12px] text-muted">
          {t('workflows.runner.progress')
            .replace('{done}', String(progress.done))
            .replace('{total}', String(progress.total))}
        </span>
        {runState?.status === 'running' && (
          <Loader2 size={15} className="animate-spin text-primary" />
        )}
        <div className="ml-auto flex items-center gap-2">
          {runState?.status === 'paused' && (
            <Button onClick={handleResume} disabled={busy} className="gap-1.5">
              <ArrowRight size={14} /> {t('workflows.runner.next')}
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={() =>
              router.push(`/workflows/runs?id=${encodeURIComponent(workflowId)}`)
            }
            className="gap-1.5"
          >
            {t('workflows.runner.backToRuns')}
          </Button>
          {runState?.sessionId && (
            <Button
              variant="ghost"
              onClick={() =>
                router.push(
                  `/ai-chat?sid=${encodeURIComponent(runState.sessionId)}`,
                )
              }
              className="gap-1.5"
            >
              <MessageSquare size={14} /> {t('workflows.runner.goToSession')}
            </Button>
          )}
        </div>
      </header>

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="h-[calc(100vh-15rem)] min-h-[480px] flex-1 overflow-hidden rounded-2xl border border-hairline bg-canvas">
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            nodesDraggable={false}
            nodesConnectable={false}
            onNodeClick={(_event, node) => setSelectedNodeId(node.id)}
            onPaneClick={() => setSelectedNodeId(null)}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={16} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>

        <aside className="w-full shrink-0 space-y-4 lg:w-[360px] lg:max-h-[calc(100vh-15rem)] lg:overflow-y-auto">
          {selectedNode ? (
            <NodeDetailPanel
              node={selectedNode}
              draft={drafts[selectedNode.nodeId] ?? selectedNode.output}
              onDraftChange={(value) =>
                setDrafts((prev) => ({ ...prev, [selectedNode.nodeId]: value }))
              }
              onCast={() => openPaipan(selectedNode.nodeId)}
              onRerun={() => handleRerun(selectedNode.nodeId)}
              onSkip={() => handleSkip(selectedNode.nodeId)}
              onSaveOutput={() => handleSaveOutput(selectedNode.nodeId)}
              savingOutput={savingOutput}
              busy={busy}
              t={t}
            />
          ) : (
            <div className="rounded-2xl border border-dashed border-hairline bg-surface-card p-6 text-center text-[12px] text-muted">
              {t('workflows.runner.pickNode')}
            </div>
          )}

          {leafOutputs.length > 0 && (
            <div className="space-y-3 rounded-2xl border border-primary/25 bg-primary/5 p-4">
              <p className="text-sm font-semibold text-ink">
                {t('workflows.runner.outputsTitle')}
              </p>
              {leafOutputs.map((node) => (
                <button
                  key={node.nodeId}
                  type="button"
                  onClick={() => setSelectedNodeId(node.nodeId)}
                  className="block w-full rounded-lg bg-surface-card px-3 py-2 text-left text-[12px] text-body hover:bg-primary/5"
                >
                  <span className="font-medium text-ink">{node.title}</span>
                  <span className="mt-0.5 line-clamp-2 text-muted">
                    {node.output}
                  </span>
                </button>
              ))}
            </div>
          )}
        </aside>
      </div>

      {paipanSheet && runState && (
        <PaipanSheet
          key={paipanSheet.nodeId}
          open
          mode="current-session"
          catalog={catalog}
          catalogLoading={catalogLoading}
          sessionId={runState.sessionId}
          initialSkill={paipanSheet.skill}
          initialClientId={runState.clientId ?? clientId ?? null}
          lockSkill
          canCommit
          onClose={() => {
            // 卦师取消(未提交)→ 记下该节点,不再自动重弹(可手动点"开始排盘")。
            if (paipanSheet && !committedRef.current) {
              dismissedPaipanRef.current.add(paipanSheet.nodeId);
            }
            setPaipanSheet(null);
          }}
          onCommitted={handlePaipanCommitted}
        />
      )}
    </div>
  );
}

export default function RunWorkflowPage() {
  return (
    <AppShell wide>
      <Suspense
        fallback={
          <div className="flex min-h-[40vh] items-center justify-center">
            <Loader2 className="animate-spin text-muted" />
          </div>
        }
      >
        <RunWorkflowInner />
      </Suspense>
    </AppShell>
  );
}
