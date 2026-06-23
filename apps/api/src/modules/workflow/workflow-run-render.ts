/**
 * 工作流运行的纯渲染逻辑(无 IO,便于单测)。
 *
 * - renderWorkflowPrompt:把 AI 节点 prompt 里的 {{input.<key>}} / {{node.<nodeId>.output}} 替换为实际值。
 * - collectNodeOutputs:从会话消息里按 id 约定收集各节点最新产出。
 */

/** 引用占位符:{{ input.xxx }} 或 {{ node.<nodeId>.output }}。 */
const REF_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;

/**
 * 渲染 AI 节点 prompt。
 *
 * @param template prompt 模板。
 * @param context input 为本次运行输入;nodeOutputs 为各节点最新产出(nodeId→文本)。
 * @returns 渲染后的 prompt;未知引用渲染为空串(避免把 {{}} 原样发给模型)。
 */
export function renderWorkflowPrompt(
  template: string,
  context: {
    input: Record<string, string>;
    nodeOutputs: Record<string, string>;
  },
): string {
  return template.replace(REF_PATTERN, (_whole, rawRef: string) => {
    const ref = rawRef.trim();
    if (ref.startsWith('input.')) {
      return context.input[ref.slice('input.'.length)] ?? '';
    }
    // nodeId 字符集已放开(可含 '-',如 nanoid),引用正则同步允许 '-',否则 {{node.my-node.output}} 静默失效。
    const nodeMatch = /^node\.([A-Za-z0-9_-]+)\.output$/.exec(ref);
    if (nodeMatch) {
      return context.nodeOutputs[nodeMatch[1]] ?? '';
    }
    return '';
  });
}

/** collectNodeOutputs / findLatestNodeReply 读取所需的最小消息形状。 */
export interface WorkflowOutputMessage {
  id: string;
  content: string;
  timestamp: string;
  /** 结构化节点关联列(P0 起);旧消息为空时回退 id 约定解析。 */
  workflow_node_id?: string | null;
  /** 用于排除盘面(metadata.kind='board_result')—— 盘面带 node 列但不是文本产出。 */
  metadata?: unknown;
}

/**
 * 解出"该消息作为 AI 文本产出所归属的节点 id";非节点文本产出返回 undefined。
 *
 * @remarks
 * - 列优先:workflow_node_id 列(P0 起的结构化关联);列为空时回退旧 id 约定 `wf-<nodeId>-…_reply`
 *   解析(历史消息 / 进程重启等边角数据)。
 * - 排盘盘面(metadata.kind='board_result')虽带 workflow_node_id 列,但它是盘面、不是 {{node.output}}
 *   引用的文本产出,按 kind 排除;运行起始消息(wf-run-…)无该列、id 也不以 _reply 结尾,天然排除。
 */
export function resolveNodeOutputId(
  message: Pick<WorkflowOutputMessage, 'id' | 'workflow_node_id' | 'metadata'>,
): string | undefined {
  const kind = (message.metadata as { kind?: unknown } | null | undefined)?.kind;
  // 盘面(board_result)与失败消息(error)虽可能带 node 列,但都不是 {{node.output}} 的文本产出。
  if (kind === 'board_result' || kind === 'error') return undefined;
  if (message.workflow_node_id) return message.workflow_node_id;
  // 回退:旧消息无列,按 id 约定 `wf-<nodeId>-…_reply`(nodeId 不含 '-',按首个 '-' 切出)。
  if (!message.id.startsWith('wf-') || !message.id.endsWith('_reply')) {
    return undefined;
  }
  const rest = message.id.slice('wf-'.length);
  const dashIndex = rest.indexOf('-');
  if (dashIndex <= 0) return undefined;
  return rest.slice(0, dashIndex);
}

/**
 * 解出"该消息作为节点失败回报所归属的节点 id";非失败消息返回 undefined。
 *
 * @remarks 与 resolveNodeOutputId 对称(成功路径有列 + id 双兜底,失败路径原先只认列):
 *   - 列优先:workflow_node_id 列;
 *   - 列为空时回退旧 id 约定 `wf-<nodeId>-…_error`(outbox 落失败回复用 `${userMessageId}_error`,
 *     而 userMessageId 形如 `wf-<nodeId>-…`,nodeId 不含 '-')。
 *   修复点:AI 节点 in-flight 期间进程内 pending 丢失(如 30min pending 超时竞态/进程重启)致
 *   workflow_node_id 列写不上 null 时,失败节点仍能被 reconcile 识别 → markNodeFailed,
 *   避免该节点永远停在 running、整个 run 永不收敛(只能人工跳过/手填)。
 */
export function resolveNodeErrorId(
  message: Pick<WorkflowOutputMessage, 'id' | 'workflow_node_id' | 'metadata'>,
): string | undefined {
  const kind = (message.metadata as { kind?: unknown } | null | undefined)?.kind;
  if (kind !== 'error') return undefined;
  if (message.workflow_node_id) return message.workflow_node_id;
  if (!message.id.startsWith('wf-') || !message.id.endsWith('_error')) {
    return undefined;
  }
  const rest = message.id.slice('wf-'.length);
  const dashIndex = rest.indexOf('-');
  if (dashIndex <= 0) return undefined;
  return rest.slice(0, dashIndex);
}

/**
 * 从会话消息里收集各 AI 节点的最新文本产出(nodeId → 回复文本)。
 *
 * @remarks 关联走 resolveNodeOutputId(列优先 + id 回退);同一节点多次运行/重跑时按时间戳取最新,
 *          从而拿到卦师润色后的版本。盘面消息被排除。
 */
export function collectNodeOutputs(
  messages: WorkflowOutputMessage[],
): Record<string, string> {
  const latestByNode = new Map<
    string,
    { content: string; timestamp: string }
  >();
  for (const message of messages) {
    const nodeId = resolveNodeOutputId(message);
    if (!nodeId) continue;
    const prev = latestByNode.get(nodeId);
    if (!prev || message.timestamp >= prev.timestamp) {
      latestByNode.set(nodeId, {
        content: message.content,
        timestamp: message.timestamp,
      });
    }
  }
  const result: Record<string, string> = {};
  for (const [nodeId, value] of latestByNode) {
    result[nodeId] = value.content;
  }
  return result;
}
