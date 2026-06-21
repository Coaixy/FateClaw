/**
 * 工作流运行的纯拓扑逻辑(无 IO,便于单测)。
 *
 * 编排器据此判定"哪些节点就绪可执行""级联重跑要重置哪些下游""运行整体到了什么状态",
 * 与持久化/执行完全解耦。约定:节点 status ∈ {done,skipped,manual} 视为"已满足"(下游可放行);
 * 'error' 不满足(卡住其下游);'running'/'awaiting_paipan' 为在途。
 */
import type {
  WorkflowGraphDto,
  WorkflowRunNodeStatus,
} from '@fateclaw/contracts/workflow';

/** 状态映射:nodeId → 节点运行状态(缺省视为 pending)。 */
export type NodeStatusMap = Record<string, WorkflowRunNodeStatus>;

/** 下游可放行所需的上游"已满足"状态。 */
const SATISFIED: ReadonlySet<WorkflowRunNodeStatus> = new Set([
  'done',
  'skipped',
  'manual',
]);

/** 在途(还在跑 / 等卦师起盘)的状态。 */
const IN_FLIGHT: ReadonlySet<WorkflowRunNodeStatus> = new Set([
  'running',
  'awaiting_paipan',
]);

function statusOf(map: NodeStatusMap, nodeId: string): WorkflowRunNodeStatus {
  return map[nodeId] ?? 'pending';
}

/** 某节点的全部直接上游(入边 source 集合)。 */
export function inboundSources(
  graph: WorkflowGraphDto,
  nodeId: string,
): string[] {
  return graph.edges
    .filter((edge) => edge.target === nodeId)
    .map((edge) => edge.source);
}

/**
 * 计算当前就绪可执行的节点 id:自身 status='pending' 且所有直接上游 status ∈ {done,skipped,manual}。
 *
 * @remarks 无入边的起点节点天然就绪;并行分叉会一次返回多个就绪节点(是否并行执行由编排器/锁决定)。
 */
export function computeReadyNodes(
  graph: WorkflowGraphDto,
  statusByNode: NodeStatusMap,
): string[] {
  return graph.nodes
    .filter((node) => statusOf(statusByNode, node.id) === 'pending')
    .filter((node) =>
      inboundSources(graph, node.id).every((source) =>
        SATISFIED.has(statusOf(statusByNode, source)),
      ),
    )
    .map((node) => node.id);
}

/**
 * 某节点的全部下游后代(含间接),用于"从此节点重跑"时级联重置下游。
 *
 * @remarks BFS 沿出边 source→target 收集;DAG 无环,故无需 visited 之外的环检测。
 */
export function descendantsOf(
  graph: WorkflowGraphDto,
  nodeId: string,
): string[] {
  const visited = new Set<string>();
  const queue: string[] = [nodeId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const edge of graph.edges) {
      if (edge.source === current && !visited.has(edge.target)) {
        visited.add(edge.target);
        queue.push(edge.target);
      }
    }
  }
  return [...visited];
}

/**
 * 由节点状态派生运行整体状态(只产出 running/done/error;paused/canceled 是编排器服务层决策)。
 *
 * - 有就绪节点或在途节点 → running。
 * - 无可推进:存在 error 或被卡住的 pending(上游出错)→ error;否则全部已满足 → done。
 */
export function deriveRunStatus(
  graph: WorkflowGraphDto,
  statusByNode: NodeStatusMap,
): 'running' | 'done' | 'error' {
  const ready = computeReadyNodes(graph, statusByNode);
  const inFlight = graph.nodes.some((node) =>
    IN_FLIGHT.has(statusOf(statusByNode, node.id)),
  );
  if (ready.length > 0 || inFlight) {
    return 'running';
  }
  const hasUnfinished = graph.nodes.some((node) => {
    const status = statusOf(statusByNode, node.id);
    return status === 'error' || status === 'pending';
  });
  return hasUnfinished ? 'error' : 'done';
}
