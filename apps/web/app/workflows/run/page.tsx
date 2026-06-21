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
  useEdgesState,
  useNodesState,
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
  Sparkles,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { ArtifactRenderer } from '@/components/chat/artifact-renderer';
import {
  chatSessionsApi,
  parseToolContext,
  type SkillContextEntry,
} from '@/features/chat/api';
import {
  paipanApi,
  type PaipanCatalogItem,
  type PaipanCommitResponse,
} from '@/features/paipan/api';
import {
  workflowsApi,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowRunNode,
} from '@/features/workflows/api';
import { ApiError } from '@/lib/http/client';
import { useI18n } from '@/lib/i18n';
import { useToast } from '@/lib/use-toast';

// 复用"直接对话"的排盘表单:运行到排盘节点时弹出,卦师当场引导填参+提交出盘到本次会话。
const PaipanSheet = dynamic(
  () =>
    import('@/components/ai-chat/paipan-sheet').then(
      (module) => module.PaipanSheet,
    ),
  { ssr: false },
);

const POLL_INTERVAL_MS = 1500;
const POLL_MAX_ATTEMPTS = 160; // ~4 分钟兜底

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type NodeStatus = 'pending' | 'running' | 'done' | 'error';

interface RunNodeState {
  node: WorkflowRunNode;
  status: NodeStatus;
  output: string;
  error?: string;
  /** 该节点产出的盘面/artifact(排盘节点的盘面、AI 节点若带 artifact),用 ArtifactRenderer 渲染。 */
  toolContext?: SkillContextEntry[];
}

// 画布上运行态节点的数据(用 type 别名以满足 React Flow v12 的 Node data 约束)。
type RunNodeData = {
  title: string;
  kind: 'paipan' | 'ai';
  status: NodeStatus;
  selected: boolean;
};
type RunFlowNode = Node<RunNodeData>;

/**
 * 拓扑排序(Kahn);并行分支按此顺序逐个串行执行(同会话有处理锁)。
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
 */
async function waitForReply(
  sessionId: string,
  messageId: string,
): Promise<{ ok: boolean; content: string; toolContext: SkillContextEntry[] }> {
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
      const toolContext = parseToolContext(byId.tool_context);
      if (kind === 'final')
        return { ok: true, content: byId.content, toolContext };
      if (kind === 'error')
        return { ok: false, content: byId.content, toolContext };
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
          toolContext: parseToolContext(latest.tool_context),
        };
      }
      if (byId)
        return {
          ok: true,
          content: byId.content,
          toolContext: parseToolContext(byId.tool_context),
        };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { ok: false, content: '', toolContext: [] };
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
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [paipanSheet, setPaipanSheet] = useState<{
    index: number;
    skill: string;
  } | null>(null);
  const [catalog, setCatalog] = useState<PaipanCatalogItem[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [rfNodes, setRfNodes, onRfNodesChange] = useNodesState<RunFlowNode>([]);
  const [rfEdges, setRfEdges, onRfEdgesChange] = useEdgesState<Edge>([]);

  const sessionIdRef = useRef<string>('');
  const orderRef = useRef<WorkflowRunNode[]>([]);
  const leafIdsRef = useRef<Set<string>>(new Set());
  // 串行闸:跑链期间外部触发(开始/下一步/重跑)直接忽略,避免快速双击并发自触发。
  const runningRef = useRef(false);
  const skillByNodeIdRef = useRef<Record<string, string>>({});
  const paipanCommittedRef = useRef(false);

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

  // 排盘表单需要术数目录,运行前预拉。
  useEffect(() => {
    let cancelled = false;
    setCatalogLoading(true);
    paipanApi
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

  const statusById = useMemo(() => {
    const map: Record<string, NodeStatus> = {};
    for (const state of nodeStates) map[state.node.id] = state.status;
    return map;
  }, [nodeStates]);

  // 把运行状态 + 选中态同步进画布节点 data,触发节点重绘变色。
  // 无变化的节点返回原引用、整体无变化时返回原数组,避免无谓重渲染/节点闪烁。
  useEffect(() => {
    setRfNodes((nds) => {
      let changed = false;
      const next = nds.map((n) => {
        const status = statusById[n.id] ?? 'pending';
        const selected = n.id === selectedNodeId;
        if (n.data.status === status && n.data.selected === selected) {
          return n;
        }
        changed = true;
        return { ...n, data: { ...n.data, status, selected } };
      });
      return changed ? next : nds;
    });
  }, [statusById, selectedNodeId, setRfNodes]);

  const patchNode = useCallback((index: number, patch: Partial<RunNodeState>) => {
    setNodeStates((prev) =>
      prev.map((state, i) => (i === index ? { ...state, ...patch } : state)),
    );
  }, []);

  // 递归执行 worker:排盘节点弹表单(暂停,提交回调里续跑);AI 节点轮询;自动节点连跑、暂停节点停。
  const executeFrom = useCallback(
    async (index: number) => {
      const sessionId = sessionIdRef.current;
      const order = orderRef.current;
      if (!sessionId || index >= order.length) {
        setBusy(false);
        setAllDone(true);
        return;
      }
      const node = order[index];
      setCurrentIndex(index);
      setSelectedNodeId(node.id);

      if (node.type === 'paipan') {
        setBusy(false);
        patchNode(index, { status: 'running', error: undefined });
        paipanCommittedRef.current = false;
        setPaipanSheet({ index, skill: skillByNodeIdRef.current[node.id] ?? '' });
        return;
      }

      setBusy(true);
      patchNode(index, { status: 'running', error: undefined });

      let exec;
      try {
        exec = await workflowsApi.runNode(workflowId, sessionId, node.id);
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

      if (exec.assistantMessageId) {
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
        patchNode(index, {
          status: 'done',
          output: reply.content,
          toolContext: reply.toolContext,
        });
      } else {
        patchNode(index, {
          status: 'done',
          output: t('workflows.runner.boardGenerated'),
        });
      }

      setBusy(false);
      if (!node.pauseAfter) {
        await executeFrom(index + 1);
      }
    },
    [workflowId, patchNode, t],
  );

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

  const handlePaipanCommitted = useCallback(
    async (result: PaipanCommitResponse) => {
      if (!paipanSheet) return;
      const index = paipanSheet.index;
      paipanCommittedRef.current = true;
      // commit 返回的 resultMessage 即盘面消息,解析其 tool_context 在画布详情面板渲染盘面。
      patchNode(index, {
        status: 'done',
        output: t('workflows.runner.boardGenerated'),
        toolContext: parseToolContext(result.resultMessage.tool_context),
      });
      if (!orderRef.current[index]?.pauseAfter) {
        void runNode(index + 1);
      }
    },
    [paipanSheet, patchNode, runNode, t],
  );

  const handlePaipanClose = useCallback(() => {
    const current = paipanSheet;
    setPaipanSheet(null);
    if (current && !paipanCommittedRef.current) {
      patchNode(current.index, { status: 'pending' });
    }
    paipanCommittedRef.current = false;
  }, [paipanSheet, patchNode]);

  const openPaipanFor = useCallback(
    (index: number) => {
      const node = orderRef.current[index];
      if (!node) return;
      setCurrentIndex(index);
      setSelectedNodeId(node.id);
      patchNode(index, { status: 'running', error: undefined });
      paipanCommittedRef.current = false;
      setPaipanSheet({ index, skill: skillByNodeIdRef.current[node.id] ?? '' });
    },
    [patchNode],
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
      const skillMap: Record<string, string> = {};
      for (const graphNode of workflow?.graph.nodes ?? []) {
        if (graphNode.type === 'paipan') skillMap[graphNode.id] = graphNode.skill;
      }
      skillByNodeIdRef.current = skillMap;
      leafIdsRef.current = new Set(
        res.nodes
          .filter((node) => !res.edges.some((edge) => edge.source === node.id))
          .map((node) => node.id),
      );
      setNodeStates(
        order.map((node) => ({ node, status: 'pending', output: '' })),
      );
      // 画布按定义里的坐标布局渲染(只读),运行时节点变色。
      setRfNodes(
        (workflow?.graph.nodes ?? []).map((graphNode) => ({
          id: graphNode.id,
          type: 'run',
          position: graphNode.position ?? { x: 0, y: 0 },
          data: {
            title: graphNode.title,
            kind: graphNode.type,
            status: 'pending' as NodeStatus,
            selected: false,
          },
        })),
      );
      setRfEdges(
        (workflow?.graph.edges ?? []).map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          markerEnd: { type: MarkerType.ArrowClosed },
        })),
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
  }, [
    workflowId,
    clientId,
    question,
    runNode,
    t,
    toast,
    workflow,
    setRfNodes,
    setRfEdges,
  ]);

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

  const nodeTypes = useMemo(() => ({ run: RunFlowNodeView }), []);

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

  if (phase === 'start') {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <header>
          <h1 className="text-2xl font-bold tracking-tight text-ink">
            {workflow.name}
          </h1>
          <p className="mt-1 text-sm text-muted">
            {t('workflows.runner.title')}
          </p>
        </header>
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
          <Button onClick={handleStart} loading={starting} icon={<Play size={15} />}>
            {t('workflows.runner.start')}
          </Button>
        </section>
      </div>
    );
  }

  // running 阶段:画布(节点实时变色)+ 右侧选中节点详情面板
  const doneCount = nodeStates.filter((s) => s.status === 'done').length;
  const selectedIndex = selectedNodeId
    ? nodeStates.findIndex((s) => s.node.id === selectedNodeId)
    : -1;
  const selectedState = selectedIndex >= 0 ? nodeStates[selectedIndex] : null;
  const leafOutputs = nodeStates.filter(
    (s) =>
      leafIdsRef.current.has(s.node.id) &&
      s.node.type === 'ai' &&
      s.status === 'done' &&
      s.output.trim().length > 0,
  );

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-ink">
            {workflow.name}
          </h1>
          <p className="mt-0.5 text-[12px] text-muted">
            {t('workflows.runner.progress', {
              done: doneCount,
              total: nodeStates.length,
            })}
            {busy ? ` · ${t('workflows.runner.nodeRunning')}` : ''}
          </p>
        </div>
        {allDone && (
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
        )}
      </header>

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="h-[calc(100vh-15rem)] min-h-[480px] flex-1 overflow-hidden rounded-2xl border border-hairline bg-canvas">
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            onNodesChange={onRfNodesChange}
            onEdgesChange={onRfEdgesChange}
            nodeTypes={nodeTypes}
            nodesDraggable={false}
            nodesConnectable={false}
            edgesFocusable={false}
            onNodeClick={(_event, node) => setSelectedNodeId(node.id)}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={16} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>

        <aside className="w-full shrink-0 space-y-4 lg:w-[360px] lg:max-h-[calc(100vh-15rem)] lg:overflow-y-auto">
          {selectedState ? (
            <NodeDetailPanel
              state={selectedState}
              isPaused={
                selectedIndex === currentIndex &&
                selectedState.status === 'done' &&
                selectedState.node.pauseAfter &&
                !busy &&
                !allDone
              }
              canCast={
                selectedState.node.type === 'paipan' &&
                selectedIndex === currentIndex &&
                selectedState.status === 'pending' &&
                paipanSheet === null &&
                !busy &&
                !allDone
              }
              savingRefine={savingRefine}
              onEditOutput={(value) =>
                patchNode(selectedIndex, { output: value })
              }
              onRefine={() => handleRefine(selectedIndex)}
              onRerun={() => runNode(selectedIndex)}
              onNext={() => runNode(selectedIndex + 1)}
              onCast={() => openPaipanFor(selectedIndex)}
            />
          ) : (
            <div className="rounded-2xl border border-dashed border-hairline bg-surface-card p-6 text-center text-[12px] text-muted">
              {t('workflows.runner.pickNode')}
            </div>
          )}

          {allDone && leafOutputs.length > 0 && (
            <div className="space-y-3 rounded-2xl border border-primary/25 bg-primary/5 p-4">
              <p className="text-[12px] font-semibold text-primary">
                {t('workflows.runner.outputsTitle')}
              </p>
              {leafOutputs.map((state) => (
                <button
                  key={state.node.id}
                  type="button"
                  onClick={() => setSelectedNodeId(state.node.id)}
                  className="block w-full rounded-lg bg-surface-card px-3 py-2 text-left transition-colors hover:bg-surface-cream-strong"
                >
                  <p className="text-[12px] font-medium text-ink">
                    {state.node.title}
                  </p>
                  <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-muted">
                    {state.output}
                  </p>
                </button>
              ))}
            </div>
          )}
        </aside>
      </div>

      {/* 排盘节点的"直接对话"式排盘表单 */}
      <PaipanSheet
        open={paipanSheet !== null}
        mode="current-session"
        catalog={catalog}
        catalogLoading={catalogLoading}
        sessionId={sessionIdRef.current || undefined}
        initialSkill={paipanSheet?.skill ?? null}
        initialClientId={clientId ?? null}
        lockSkill
        canCommit
        onClose={handlePaipanClose}
        onCommitted={handlePaipanCommitted}
      />
    </div>
  );
}

/** 画布上运行态节点:按 status 变色,显示类型/标题/状态。 */
function RunFlowNodeView({ data }: NodeProps) {
  const d = data as RunNodeData;
  const { t } = useI18n();

  const ring =
    d.status === 'error'
      ? 'border-error/50'
      : d.status === 'running'
        ? 'border-primary ring-2 ring-primary/30'
        : d.status === 'done'
          ? 'border-emerald-500/50'
          : 'border-hairline';
  const selectedRing = d.selected ? ' ring-2 ring-primary/40' : '';

  return (
    <div
      className={`min-w-[160px] rounded-xl border bg-surface-card px-3 py-2 shadow-sm transition-colors ${ring}${selectedRing}`}
    >
      <Handle type="target" position={Position.Left} className="!opacity-0" />
      <div className="flex items-center gap-1.5">
        {d.kind === 'paipan' ? (
          <Compass size={13} className="text-primary" />
        ) : (
          <Sparkles size={13} className="text-success" />
        )}
        <span
          className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${
            d.kind === 'paipan'
              ? 'bg-primary/10 text-primary'
              : 'bg-success/10 text-success'
          }`}
        >
          {d.kind === 'paipan'
            ? t('workflows.builder.paipanBadge')
            : t('workflows.builder.aiBadge')}
        </span>
        <span className="ml-auto">
          <RunStatusDot status={d.status} />
        </span>
      </div>
      <p className="mt-1 truncate text-[12px] font-medium text-ink">
        {d.title}
      </p>
      <Handle type="source" position={Position.Right} className="!opacity-0" />
    </div>
  );
}

function RunStatusDot({ status }: { status: NodeStatus }) {
  if (status === 'running') {
    return <Loader2 size={13} className="animate-spin text-primary" />;
  }
  if (status === 'done') {
    return <Check size={13} className="text-emerald-600" />;
  }
  if (status === 'error') {
    return <AlertCircle size={13} className="text-error" />;
  }
  return <span className="block h-2 w-2 rounded-full bg-muted/40" />;
}

function NodeDetailPanel({
  state,
  isPaused,
  canCast,
  savingRefine,
  onEditOutput,
  onRefine,
  onRerun,
  onNext,
  onCast,
}: {
  state: RunNodeState;
  isPaused: boolean;
  canCast: boolean;
  savingRefine: boolean;
  onEditOutput: (value: string) => void;
  onRefine: () => void;
  onRerun: () => void;
  onNext: () => void;
  onCast: () => void;
}) {
  const { t } = useI18n();
  const { node, status, output, error } = state;

  return (
    <div className="space-y-3 rounded-2xl border border-hairline bg-surface-card p-4">
      <div className="flex items-center gap-2">
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
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">
          {node.title}
        </span>
        <StatusIndicator status={status} />
      </div>

      {error && <p className="text-[12px] text-error">{error}</p>}

      {/* 盘面/artifact:排盘节点出的盘、AI 节点若带 artifact 都在此渲染(复用 ArtifactRenderer)。 */}
      {state.toolContext && state.toolContext.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-hairline bg-canvas p-2">
          <ArtifactRenderer entries={state.toolContext} />
        </div>
      )}

      {canCast && (
        <Button size="sm" icon={<Compass size={13} />} onClick={onCast}>
          {t('workflows.runner.castBoard')}
        </Button>
      )}

      {node.type === 'ai' && output && status !== 'error' && (
        <div>
          {isPaused ? (
            <>
              <textarea
                value={output}
                onChange={(event) => onEditOutput(event.target.value)}
                rows={8}
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

      {node.type === 'paipan' && isPaused && (
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-muted">
            {t('workflows.runner.boardGenerated')}
          </span>
          <Button size="sm" icon={<ArrowRight size={13} />} onClick={onNext}>
            {t('workflows.runner.next')}
          </Button>
        </div>
      )}

      {status === 'error' && (
        <Button
          size="sm"
          variant="secondary"
          icon={<RefreshCw size={13} />}
          onClick={onRerun}
        >
          {t('workflows.runner.rerun')}
        </Button>
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
    <AppShell wide>
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
