import type { WorkflowEdgeDto, WorkflowGraphDto } from '@fateclaw/contracts/workflow';

/** 画布坐标。 */
export interface NodeXY {
  x: number;
  y: number;
}

/** 自动布局的层间距 / 层内间距(像素)。 */
const LAYER_GAP_X = 240;
const ROW_GAP_Y = 110;

interface MinimalNode {
  id: string;
  position?: NodeXY;
}

/**
 * 是否需要对整图做自动布局兜底。
 *
 * @remarks 触发条件:存在没有坐标的节点(早期/线性迁移来的工作流),或所有节点坐标完全相同
 *          (历史上误存成同一点,典型是都落在原点 {0,0} 重叠)。两种情况下保存的坐标都不可用。
 */
function needsAutoLayout(nodes: MinimalNode[]): boolean {
  if (nodes.length === 0) return false;
  if (nodes.some((node) => !node.position)) return true;
  if (nodes.length <= 1) return false;
  const first = nodes[0].position as NodeXY;
  return nodes.every(
    (node) =>
      (node.position as NodeXY).x === first.x &&
      (node.position as NodeXY).y === first.y,
  );
}

/**
 * 按拓扑"最长路径"分层给整图布点:depth 越大越靠右(x),同层内按出现顺序往下排(y)。
 *
 * @remarks 图已保证是 DAG(路由校验无环);若拓扑异常未覆盖全部节点,剩余节点退化为按序网格,
 *          保证任何情况下都不重叠。
 */
function layeredPositions(
  nodeIds: string[],
  edges: WorkflowEdgeDto[],
): Record<string, NodeXY> {
  const indegree = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  const adjacency = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  const idSet = new Set(nodeIds);
  for (const edge of edges) {
    if (!idSet.has(edge.source) || !idSet.has(edge.target)) continue;
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    adjacency.get(edge.source)?.push(edge.target);
  }

  // Kahn 拓扑序;同时按最长路径累计 depth。
  const depth = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  const queue = nodeIds.filter((id) => (indegree.get(id) ?? 0) === 0);
  const order: string[] = [];
  const working = new Map(indegree);
  while (queue.length > 0) {
    const current = queue.shift() as string;
    order.push(current);
    for (const next of adjacency.get(current) ?? []) {
      depth.set(next, Math.max(depth.get(next) ?? 0, (depth.get(current) ?? 0) + 1));
      const left = (working.get(next) ?? 0) - 1;
      working.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  // 拓扑未覆盖的(理论不会有,DAG 保证)按序补到末尾,避免漏点。
  for (const id of nodeIds) {
    if (!order.includes(id)) order.push(id);
  }

  const rowCursor = new Map<number, number>();
  const result: Record<string, NodeXY> = {};
  for (const id of order) {
    const d = depth.get(id) ?? 0;
    const row = rowCursor.get(d) ?? 0;
    rowCursor.set(d, row + 1);
    result[id] = { x: d * LAYER_GAP_X, y: row * ROW_GAP_Y };
  }
  return result;
}

/**
 * 解析每个节点最终用于画布渲染的坐标:有有效保存坐标就用保存的;否则对整图做拓扑分层自动布局。
 *
 * @param graph 工作流图(节点 + 边)。
 * @returns nodeId → {x,y}。
 * @remarks 修复"早期/线性迁移工作流节点无坐标 → 全堆在原点重叠"的历史问题。搭建器与运行页共用。
 */
export function resolveNodePositions(
  graph: WorkflowGraphDto,
): Record<string, NodeXY> {
  if (!needsAutoLayout(graph.nodes)) {
    const saved: Record<string, NodeXY> = {};
    for (const node of graph.nodes) {
      saved[node.id] = node.position ?? { x: 0, y: 0 };
    }
    return saved;
  }
  return layeredPositions(
    graph.nodes.map((node) => node.id),
    graph.edges,
  );
}
