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
  SkipForward,
  Sparkles,
} from 'lucide-react';

import { AppShell } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { ArtifactRenderer } from '@/components/chat/artifact-renderer';
import {
  chatSessionsApi,
  parseToolContext,
  type Message,
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
  type WorkflowRunInput,
  type WorkflowRunNode,
} from '@/features/workflows/api';
import { resolveNodePositions } from '@/features/workflows/layout';
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
  /** AI 节点执行中的最新进度(工具调用 trace,如「排盘: bazi 中」),让运行不再是黑盒转圈。 */
  progressText?: string;
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
  onProgress?: (text: string) => void,
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
    // 执行中:把会话里最新的工具进度(tool_trace,如「排盘: bazi 中」)回传 UI,
    // 让卦师看到 AI 节点在干什么、是否还在动(串行执行下最新 trace 即当前节点的)。
    if (onProgress) {
      let latest: { content: string; timestamp: string } | undefined;
      for (const message of res.messages) {
        if (
          message.is_bot_message &&
          message.metadata?.kind === 'tool_trace' &&
          message.content &&
          (!latest || message.timestamp >= latest.timestamp)
        ) {
          latest = { content: message.content, timestamp: message.timestamp };
        }
      }
      if (latest) onProgress(latest.content);
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

/**
 * 查看历史运行:从会话消息重建各节点的只读状态(全部已完成)。
 *
 * - AI 节点产出按 `wf-<nodeId>-…_reply` id 约定取最新。
 * - 排盘节点盘面:盘面消息(metadata.kind='board_result')不带节点 id,但其落库顺序 = 排盘节点
 *   执行顺序 = 拓扑序的排盘子序列,故按时间序依次对应到拓扑序的排盘节点重建盘面
 *   (正常运行精确;运行中对同一排盘重跑过的边角情况可能错位,降级为显示"已起盘")。
 */
function rebuildViewNodeStates(
  order: WorkflowRunNode[],
  messages: Message[],
  boardGeneratedLabel: string,
): RunNodeState[] {
  const replyByNode = new Map<string, Message>();
  for (const message of messages) {
    if (!message.id.startsWith('wf-') || !message.id.endsWith('_reply')) {
      continue;
    }
    const rest = message.id.slice('wf-'.length);
    const dashIndex = rest.indexOf('-');
    if (dashIndex <= 0) continue;
    const nodeId = rest.slice(0, dashIndex);
    const prev = replyByNode.get(nodeId);
    if (!prev || message.timestamp >= prev.timestamp) {
      replyByNode.set(nodeId, message);
    }
  }
  // 盘面消息按时间升序(= 执行顺序),依次对应拓扑序的排盘节点。
  const boards = messages
    .filter(
      (message) =>
        message.metadata?.kind === 'board_result' && !!message.tool_context,
    )
    .sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
  let boardCursor = 0;
  return order.map((node) => {
    if (node.type === 'ai') {
      const reply = replyByNode.get(node.id);
      return {
        node,
        status: 'done' as NodeStatus,
        output: reply?.content ?? '',
        toolContext: reply ? parseToolContext(reply.tool_context) : undefined,
      };
    }
    const board = boards[boardCursor];
    boardCursor += 1;
    return {
      node,
      status: 'done' as NodeStatus,
      output: boardGeneratedLabel,
      toolContext: board ? parseToolContext(board.tool_context) : undefined,
    };
  });
}

function RunWorkflowInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { t } = useI18n();
  const { toast } = useToast();

  const workflowId = params.get('id') ?? '';
  const clientId = params.get('client') ?? undefined;
  // ?view=<sessionId>:只读查看某次历史运行(运行历史入口进来),非实时运行。
  const viewSessionId = params.get('view') ?? '';
  const isViewMode = viewSessionId !== '';

  const [phase, setPhase] = useState<
    'loading' | 'start' | 'running' | 'notfound'
  >('loading');
  const [workflow, setWorkflow] = useState<WorkflowDefinition | null>(null);
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
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
  const edgesRef = useRef<WorkflowEdge[]>([]);
  const leafIdsRef = useRef<Set<string>>(new Set());
  // 串行闸:跑链期间外部触发(开始/下一步/重跑)直接忽略,避免快速双击并发自触发。
  const runningRef = useRef(false);
  // 级联重跑闸:非 null 时只执行该集合内的节点(其余节点保持原产出),null=全跑。
  const allowedIdsRef = useRef<Set<string> | null>(null);
  const skillByNodeIdRef = useRef<Record<string, string>>({});
  // 各排盘节点产出的盘面消息 id(节点 id → 盘面 msgId),供下游 AI 指定自己这条链的主盘面。
  const boardMsgIdByNodeIdRef = useRef<Record<string, string>>({});
  const paipanCommittedRef = useRef(false);
  // 排盘提交后的待续跑节点 index:续跑延迟到 onClose 之后触发,避免新表单被 onClose 覆盖。
  const pendingResumeRef = useRef<number | null>(null);

  useEffect(() => {
    if (!workflowId) {
      setPhase('notfound');
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const data = await workflowsApi.get(workflowId);
        if (cancelled) return;
        setWorkflow(data);
        if (!isViewMode) {
          setPhase('start');
          return;
        }
        // 查看历史运行:取较大上限拉消息(后端上限 200),避免长运行早期节点产出被默认 50 截断;
        // 再重建只读节点状态(全部已完成)。
        const res = await chatSessionsApi.messages(viewSessionId, 200);
        if (cancelled) return;
        const order = topoOrder(
          data.graph.nodes.map((node) => ({
            id: node.id,
            type: node.type,
            title: node.title,
            pauseAfter: node.pauseAfter,
          })),
          data.graph.edges,
        );
        orderRef.current = order;
        edgesRef.current = data.graph.edges;
        sessionIdRef.current = viewSessionId;
        // 末端叶节点(无出边),供"最终产出"汇总卡渲染(镜像 handleStart)。
        leafIdsRef.current = new Set(
          data.graph.nodes
            .filter(
              (node) =>
                !data.graph.edges.some((edge) => edge.source === node.id),
            )
            .map((node) => node.id),
        );
        setNodeStates(
          rebuildViewNodeStates(
            order,
            res.messages,
            t('workflows.runner.boardGenerated'),
          ),
        );
        const viewPositions = resolveNodePositions(data.graph);
        setRfNodes(
          data.graph.nodes.map((graphNode) => ({
            id: graphNode.id,
            type: 'run',
            position: viewPositions[graphNode.id] ?? { x: 0, y: 0 },
            data: {
              title: graphNode.title,
              kind: graphNode.type,
              status: 'done' as NodeStatus,
              selected: false,
            },
          })),
        );
        setRfEdges(
          data.graph.edges.map((edge) => ({
            id: edge.id,
            source: edge.source,
            target: edge.target,
            markerEnd: { type: MarkerType.ArrowClosed },
          })),
        );
        setAllDone(true);
        setPhase('running');
      } catch {
        if (!cancelled) setPhase('notfound');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workflowId, isViewMode, viewSessionId, t, setRfNodes, setRfEdges]);

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

  // 运行表单的输入项:工作流定义了就用定义的;没定义(旧工作流 inputs=[])回退默认单个问题框。
  const runInputs = useMemo<WorkflowRunInput[]>(() => {
    const defined = workflow?.inputs ?? [];
    if (defined.length > 0) return defined;
    return [
      {
        key: 'question',
        label: t('workflows.runner.questionLabel'),
        type: 'textarea',
        required: false,
      },
    ];
  }, [workflow, t]);

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

  // 运行时点亮"上游已完成 → 下游执行中"的连线,直观显示数据流向(纯展示)。
  useEffect(() => {
    setRfEdges((eds) => {
      let changed = false;
      const next = eds.map((edge) => {
        const active =
          statusById[edge.source] === 'done' &&
          statusById[edge.target] === 'running';
        if (Boolean(edge.animated) === active) return edge;
        changed = true;
        return { ...edge, animated: active };
      });
      return changed ? next : eds;
    });
  }, [statusById, setRfEdges]);

  const patchNode = useCallback((index: number, patch: Partial<RunNodeState>) => {
    setNodeStates((prev) =>
      prev.map((state, i) => (i === index ? { ...state, ...patch } : state)),
    );
  }, []);

  // 收集 AI 节点【直接入边】排盘节点产出的盘面消息 id 列表 —— 只把这些盘注入该 AI,实现分支隔离。
  // 直接入边是 AI 节点的(如汇总节点),则返回空,不带任何盘,只靠上游 AI 的 output 文本。
  const directInboundBoardMsgIds = useCallback((aiNodeId: string): string[] => {
    const typeById = new Map(orderRef.current.map((n) => [n.id, n.type]));
    const ids: string[] = [];
    for (const edge of edgesRef.current) {
      if (edge.target !== aiNodeId) continue;
      if (typeById.get(edge.source) === 'paipan') {
        const msgId = boardMsgIdByNodeIdRef.current[edge.source];
        if (msgId) ids.push(msgId);
      }
    }
    return ids;
  }, []);

  // 递归执行 worker:排盘节点弹表单(暂停,提交回调里续跑);AI 节点轮询;自动节点连跑、暂停节点停。
  const executeFrom = useCallback(
    async (index: number) => {
      const sessionId = sessionIdRef.current;
      const order = orderRef.current;
      if (!sessionId || index >= order.length) {
        setBusy(false);
        setAllDone(true);
        // 一轮(含级联)跑到底,关闭级联闸,避免残留集合污染后续续跑而漏跑节点。
        // 注意:出错早退时不关闸——接下来的跳过/手填是同一次级联的延续,要继续走级联集合。
        allowedIdsRef.current = null;
        return;
      }
      const node = order[index];
      // 级联重跑模式:不在重跑集合内的节点直接略过,保持其原有产出不变。
      if (allowedIdsRef.current && !allowedIdsRef.current.has(node.id)) {
        await executeFrom(index + 1);
        return;
      }
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
        exec = await workflowsApi.runNode(
          workflowId,
          sessionId,
          node.id,
          directInboundBoardMsgIds(node.id),
        );
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
        const reply = await waitForReply(
          sessionId,
          exec.assistantMessageId,
          (text) => patchNode(index, { progressText: text }),
        );
        if (!reply.ok) {
          patchNode(index, {
            status: 'error',
            output: reply.content,
            error: reply.content || t('workflows.runner.nodeError'),
            progressText: undefined,
          });
          setBusy(false);
          return;
        }
        patchNode(index, {
          status: 'done',
          output: reply.content,
          toolContext: reply.toolContext,
          progressText: undefined,
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
    [workflowId, patchNode, directInboundBoardMsgIds, t],
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

  // 求某节点及其全部下游(沿出边 BFS,含自己),用于"从此节点重跑"只动这条链。
  const descendantsOf = useCallback((nodeId: string): Set<string> => {
    const adjacency = new Map<string, string[]>();
    for (const edge of edgesRef.current) {
      const list = adjacency.get(edge.source) ?? [];
      list.push(edge.target);
      adjacency.set(edge.source, list);
    }
    const result = new Set<string>([nodeId]);
    const stack = [nodeId];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      for (const next of adjacency.get(current) ?? []) {
        if (!result.has(next)) {
          result.add(next);
          stack.push(next);
        }
      }
    }
    return result;
  }, []);

  // 从出错节点继续把剩余节点跑完(整轮模式,不限集合):并行兄弟可能还没跑过,必须全跑。
  const rerunAll = useCallback(
    (index: number) => {
      allowedIdsRef.current = null;
      setAllDone(false);
      void runNode(index);
    },
    [runNode],
  );

  // 从某节点起级联重跑它及全部下游:重置这些节点为待执行,开启级联闸只跑这条链。
  // 仅用于工作流已整体跑完后回头重跑(此时兄弟分支都已完成,跳过它们不影响汇总)。
  const rerunFrom = useCallback(
    (index: number) => {
      const node = orderRef.current[index];
      if (!node) return;
      const ids = descendantsOf(node.id);
      allowedIdsRef.current = ids;
      setAllDone(false);
      setNodeStates((prev) =>
        prev.map((state) =>
          ids.has(state.node.id)
            ? {
                ...state,
                status: 'pending',
                output: '',
                error: undefined,
                toolContext: undefined,
              }
            : state,
        ),
      );
      void runNode(index);
    },
    [descendantsOf, runNode],
  );

  // 跳过出错节点:产出置空标完成,继续下游(下游引用该节点 output 解析为空串)。
  const handleSkip = useCallback(
    (index: number) => {
      patchNode(index, {
        status: 'done',
        output: '',
        error: undefined,
        toolContext: undefined,
      });
      void runNode(index + 1);
    },
    [patchNode, runNode],
  );

  // 手填并继续:把卦师手填内容存为该节点产出(后端没有回复消息时会补建一条),标完成续跑下游。
  const handleManualFill = useCallback(
    async (index: number) => {
      const sessionId = sessionIdRef.current;
      const state = nodeStates[index];
      if (!state) return;
      setSavingRefine(true);
      try {
        await workflowsApi.runNodeSaveOutput(
          workflowId,
          sessionId,
          state.node.id,
          state.output,
        );
        patchNode(index, { status: 'done', error: undefined });
        toast('success', t('workflows.runner.manualFilled'));
        void runNode(index + 1);
      } catch (error) {
        toast(
          'error',
          error instanceof ApiError ? error.message : t('workflows.loadError'),
        );
      } finally {
        setSavingRefine(false);
      }
    },
    [nodeStates, workflowId, patchNode, runNode, t, toast],
  );

  const handlePaipanCommitted = useCallback(
    async (result: PaipanCommitResponse) => {
      if (!paipanSheet) return;
      const index = paipanSheet.index;
      const node = orderRef.current[index];
      paipanCommittedRef.current = true;
      // 记下该排盘节点产出的盘面消息 id,供下游 AI 把它指定为主盘面(多链时避免盘面串)。
      if (node) {
        boardMsgIdByNodeIdRef.current[node.id] = result.resultMessage.id;
      }
      // commit 返回的 resultMessage 即盘面消息,解析其 tool_context 在画布详情面板渲染盘面。
      patchNode(index, {
        status: 'done',
        output: t('workflows.runner.boardGenerated'),
        toolContext: parseToolContext(result.resultMessage.tool_context),
      });
      // 不在此处续跑:PaipanSheet 提交后会紧接着调 onClose,若现在续跑开下一个排盘表单,
      // 会被 onClose 的 setPaipanSheet(null) 覆盖。改为记下待续跑节点,交给 handlePaipanClose
      // 在表单关闭后再触发(下一个若是排盘,届时才安全地开新表单)。
      pendingResumeRef.current = orderRef.current[index]?.pauseAfter
        ? null
        : index + 1;
    },
    [paipanSheet, patchNode, t],
  );

  const handlePaipanClose = useCallback(() => {
    const current = paipanSheet;
    const committed = paipanCommittedRef.current;
    paipanCommittedRef.current = false;
    setPaipanSheet(null);
    if (current && !committed) {
      // 用户取消(非提交):节点回 pending,并丢弃可能残留的待续跑。
      patchNode(current.index, { status: 'pending' });
      pendingResumeRef.current = null;
      return;
    }
    // 提交后关闭:表单此刻已关,安全续跑(下一个若是排盘会在 executeFrom 里重新开表单,无竞争)。
    const next = pendingResumeRef.current;
    pendingResumeRef.current = null;
    if (next !== null) {
      void runNode(next);
    }
  }, [paipanSheet, patchNode, runNode]);

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
    // 必填项校验:任一必填输入为空则拦下,提示具体项。
    const missing = runInputs.find(
      (input) => input.required && !(inputValues[input.key] ?? '').trim(),
    );
    if (missing) {
      toast(
        'error',
        t('workflows.runner.inputRequiredError', { label: missing.label }),
      );
      return;
    }
    setStarting(true);
    try {
      const res = await workflowsApi.runStart(workflowId, {
        clientId,
        input: Object.fromEntries(
          runInputs.map((input) => [
            input.key,
            (inputValues[input.key] ?? '').trim(),
          ]),
        ),
      });
      sessionIdRef.current = res.session.id;
      const order = topoOrder(res.nodes, res.edges);
      orderRef.current = order;
      edgesRef.current = res.edges;
      allowedIdsRef.current = null; // 整轮运行,不受级联闸限制
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
      // 画布坐标:无坐标/全同坐标的旧工作流自动分层布局,避免堆在原点重叠;运行时节点变色。
      const runPositions = workflow ? resolveNodePositions(workflow.graph) : {};
      setRfNodes(
        (workflow?.graph.nodes ?? []).map((graphNode) => ({
          id: graphNode.id,
          type: 'run',
          position: runPositions[graphNode.id] ?? { x: 0, y: 0 },
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
    runInputs,
    inputValues,
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
          {runInputs.map((input) => (
            <label key={input.key} className="block space-y-1.5">
              <span className="text-[12px] font-medium text-muted">
                {input.label}
                {input.required && <span className="text-error"> *</span>}
              </span>
              {input.type === 'textarea' ? (
                <textarea
                  value={inputValues[input.key] ?? ''}
                  onChange={(event) =>
                    setInputValues((prev) => ({
                      ...prev,
                      [input.key]: event.target.value,
                    }))
                  }
                  rows={3}
                  className="w-full resize-none rounded-lg border border-hairline bg-canvas px-3 py-2 text-[13px] text-ink placeholder:text-muted focus:border-primary focus:outline-none"
                />
              ) : (
                <input
                  value={inputValues[input.key] ?? ''}
                  onChange={(event) =>
                    setInputValues((prev) => ({
                      ...prev,
                      [input.key]: event.target.value,
                    }))
                  }
                  className="w-full rounded-lg border border-hairline bg-canvas px-3 py-2 text-[13px] text-ink placeholder:text-muted focus:border-primary focus:outline-none"
                />
              )}
            </label>
          ))}
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
            {isViewMode
              ? t('workflows.runner.viewingRun')
              : t('workflows.runner.progress', {
                  done: doneCount,
                  total: nodeStates.length,
                })}
            {!isViewMode && busy
              ? ` · ${t('workflows.runner.nodeRunning')}`
              : ''}
          </p>
        </div>
        {isViewMode ? (
          <Button
            variant="secondary"
            onClick={() =>
              router.push(
                `/workflows/runs?id=${encodeURIComponent(workflowId)}`,
              )
            }
          >
            {t('workflows.runner.backToRuns')}
          </Button>
        ) : (
          allDone && (
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
          )
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
              canRerunDownstream={
                !isViewMode &&
                allDone &&
                selectedState.status === 'done' &&
                !busy &&
                edgesRef.current.some(
                  (edge) => edge.source === selectedState.node.id,
                )
              }
              savingRefine={savingRefine}
              onEditOutput={(value) =>
                patchNode(selectedIndex, { output: value })
              }
              onRefine={() => handleRefine(selectedIndex)}
              onRerun={() => rerunAll(selectedIndex)}
              onRerunDownstream={() => rerunFrom(selectedIndex)}
              onNext={() => runNode(selectedIndex + 1)}
              onCast={() => openPaipanFor(selectedIndex)}
              onSkip={() => handleSkip(selectedIndex)}
              onManualFill={() => handleManualFill(selectedIndex)}
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

      {/* 排盘节点的"直接对话"式排盘表单。
          key 按节点 index:连续排盘(如六爻→八字)时 open 因 React 批处理不经历 false,
          PaipanSheet 的 !open 重置不触发会残留上一个表单的步骤状态(停在出盘结果步);
          用 key 强制每个排盘节点全新挂载,内部状态回到初值(从填参步开始)。 */}
      <PaipanSheet
        key={paipanSheet?.index ?? 'none'}
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
  canRerunDownstream,
  savingRefine,
  onEditOutput,
  onRefine,
  onRerun,
  onRerunDownstream,
  onNext,
  onCast,
  onSkip,
  onManualFill,
}: {
  state: RunNodeState;
  isPaused: boolean;
  canCast: boolean;
  canRerunDownstream: boolean;
  savingRefine: boolean;
  onEditOutput: (value: string) => void;
  onRefine: () => void;
  onRerun: () => void;
  onRerunDownstream: () => void;
  onNext: () => void;
  onCast: () => void;
  onSkip: () => void;
  onManualFill: () => void;
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

      {/* 执行中的实时进度:展示当前工具调用(如「排盘: bazi 中」),让运行不再是黑盒转圈。 */}
      {status === 'running' && state.progressText && (
        <p className="flex items-center gap-1.5 rounded-lg bg-canvas px-2.5 py-1.5 text-[12px] text-muted">
          <Loader2 size={12} className="shrink-0 animate-spin text-primary" />
          <span className="min-w-0 flex-1 truncate">{state.progressText}</span>
        </p>
      )}

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

      {/* 出错恢复:AI 节点可手填正文后继续、跳过或重跑;排盘节点可重试排盘或跳过。 */}
      {status === 'error' && (
        <div className="space-y-2">
          {node.type === 'ai' && (
            <>
              <textarea
                value={output}
                onChange={(event) => onEditOutput(event.target.value)}
                rows={6}
                placeholder={t('workflows.runner.manualFillPlaceholder')}
                className="w-full resize-y rounded-lg border border-hairline bg-canvas px-3 py-2 text-[13px] leading-relaxed text-ink focus:border-primary focus:outline-none"
              />
              <p className="text-[11px] text-muted/80">
                {t('workflows.runner.manualFillHint')}
              </p>
            </>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {node.type === 'ai' && (
              <Button
                size="sm"
                icon={<Save size={13} />}
                loading={savingRefine}
                onClick={onManualFill}
              >
                {t('workflows.runner.manualFill')}
              </Button>
            )}
            <Button
              size="sm"
              variant="secondary"
              icon={<RefreshCw size={13} />}
              onClick={onRerun}
            >
              {node.type === 'paipan'
                ? t('workflows.runner.retryCast')
                : t('workflows.runner.rerun')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<SkipForward size={13} />}
              onClick={onSkip}
            >
              {t('workflows.runner.skip')}
            </Button>
          </div>
        </div>
      )}

      {/* AI 完成态产出:暂停可润色,否则只读展示。 */}
      {node.type === 'ai' && output && status === 'done' && (
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

      {node.type === 'paipan' && status === 'done' && (
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-muted">
            {t('workflows.runner.boardGenerated')}
          </span>
          {isPaused && (
            <Button size="sm" icon={<ArrowRight size={13} />} onClick={onNext}>
              {t('workflows.runner.next')}
            </Button>
          )}
        </div>
      )}

      {/* 从此节点重跑:任意完成态且有下游——改了该节点后重跑它及依赖它的整条下游链。 */}
      {canRerunDownstream && (
        <Button
          size="sm"
          variant="ghost"
          icon={<RefreshCw size={13} />}
          onClick={onRerunDownstream}
        >
          {t('workflows.runner.rerunFromHere')}
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
