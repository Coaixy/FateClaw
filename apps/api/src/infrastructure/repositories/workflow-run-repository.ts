/**
 * 工作流运行(workflow_runs / workflow_run_nodes)持久化。
 *
 * 运行态独立领域实体:run 是聚合根,run_node 持节点编排状态 + 复合外键指针 (output_message_id,
 * output_account_id) → messages(id, account_id)。产出正文不存这里(单一真相在 messages)。
 */
import type {
  WorkflowRunNodeStatus,
  WorkflowRunStatus,
} from '@fateclaw/contracts/workflow';

import { getDbPool } from '../db-pool.js';

/** workflow_runs 行。 */
export interface WorkflowRunRow {
  id: string;
  user_id: string;
  workflow_definition_id: string;
  chat_session_id: string;
  client_id: string | null;
  title: string;
  status: WorkflowRunStatus;
  input: Record<string, string>;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/** workflow_run_nodes 行。 */
export interface WorkflowRunNodeRow {
  run_id: string;
  node_id: string;
  node_type: 'paipan' | 'ai';
  title: string;
  status: WorkflowRunNodeStatus;
  output_message_id: string | null;
  output_account_id: string | null;
  error: string | null;
  attempt: number;
  created_at: string;
  updated_at: string;
}

/** 新建运行的入参。 */
export interface NewWorkflowRun {
  id: string;
  userId: string;
  workflowDefinitionId: string;
  chatSessionId: string;
  clientId?: string;
  title: string;
  input: Record<string, string>;
}

/** 新建运行节点的入参(初始 status='pending')。 */
export interface NewWorkflowRunNode {
  nodeId: string;
  nodeType: 'paipan' | 'ai';
  title: string;
}

/** 节点状态/产出的局部更新补丁。 */
export interface WorkflowRunNodePatch {
  status?: WorkflowRunNodeStatus;
  /** 产出消息复合外键:两列必须同时给(同时非空或同时为空),避免单列写出脏指针。 */
  outputMessageId?: string | null;
  outputAccountId?: string | null;
  error?: string | null;
  /** 传入则把 attempt 自增 1(重跑计数)。 */
  bumpAttempt?: boolean;
}

/**
 * 事务建立一次运行:插入 run + 全部节点(初始 pending)。
 *
 * @param run 运行聚合根字段。
 * @param nodes 该运行的全部节点(来自定义 graph,顺序无关)。
 */
export async function createWorkflowRun(
  run: NewWorkflowRun,
  nodes: NewWorkflowRunNode[],
): Promise<void> {
  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO workflow_runs
         (id, user_id, workflow_definition_id, chat_session_id, client_id, title, status, input)
       VALUES ($1, $2, $3, $4, $5, $6, 'running', $7)`,
      [
        run.id,
        run.userId,
        run.workflowDefinitionId,
        run.chatSessionId,
        run.clientId ?? null,
        run.title,
        JSON.stringify(run.input ?? {}),
      ],
    );
    for (const node of nodes) {
      await client.query(
        `INSERT INTO workflow_run_nodes
           (run_id, node_id, node_type, title, status)
         VALUES ($1, $2, $3, $4, 'pending')`,
        [run.id, node.nodeId, node.nodeType, node.title],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * 读取一次运行的 run + 全部节点(按 user_id 归属校验)。
 *
 * @returns { run, nodes };不存在或非本人返回 null。
 */
export async function getWorkflowRunWithNodes(
  runId: string,
  userId: string,
): Promise<{ run: WorkflowRunRow; nodes: WorkflowRunNodeRow[] } | null> {
  const pool = getDbPool();
  const { rows: runRows } = await pool.query(
    `SELECT id, user_id, workflow_definition_id, chat_session_id, client_id,
            title, status, input, error, created_at, updated_at
       FROM workflow_runs
       WHERE id = $1 AND user_id = $2`,
    [runId, userId],
  );
  if (runRows.length === 0) {
    return null;
  }
  const { rows: nodeRows } = await pool.query(
    `SELECT run_id, node_id, node_type, title, status,
            output_message_id, output_account_id, error, attempt, created_at, updated_at
       FROM workflow_run_nodes
       WHERE run_id = $1
       ORDER BY created_at ASC, node_id ASC`,
    [runId],
  );
  return {
    run: runRows[0] as WorkflowRunRow,
    nodes: nodeRows as WorkflowRunNodeRow[],
  };
}

/**
 * 局部更新某运行节点的状态 / 产出指针 / 错误 / 重跑次数。
 *
 * @remarks 复合外键两列要么同时写、要么都不动;调用方(编排器)从执行结果原子取 (messageId, accountId)。
 */
export async function updateWorkflowRunNode(
  runId: string,
  nodeId: string,
  patch: WorkflowRunNodePatch,
): Promise<void> {
  const sets: string[] = ['updated_at = NOW()'];
  const params: unknown[] = [];
  let idx = 1;
  if (patch.status !== undefined) {
    sets.push(`status = $${idx++}`);
    params.push(patch.status);
  }
  if (patch.outputMessageId !== undefined) {
    sets.push(`output_message_id = $${idx++}`);
    params.push(patch.outputMessageId);
  }
  if (patch.outputAccountId !== undefined) {
    sets.push(`output_account_id = $${idx++}`);
    params.push(patch.outputAccountId);
  }
  if (patch.error !== undefined) {
    sets.push(`error = $${idx++}`);
    params.push(patch.error);
  }
  if (patch.bumpAttempt) {
    sets.push('attempt = attempt + 1');
  }
  params.push(runId, nodeId);
  await getDbPool().query(
    `UPDATE workflow_run_nodes SET ${sets.join(', ')}
       WHERE run_id = $${idx++} AND node_id = $${idx}`,
    params,
  );
}

/** 更新运行整体状态(可带错误信息)。 */
export async function updateWorkflowRunStatus(
  runId: string,
  status: WorkflowRunStatus,
  error?: string | null,
): Promise<void> {
  await getDbPool().query(
    `UPDATE workflow_runs SET status = $1, error = $2, updated_at = NOW()
       WHERE id = $3`,
    [status, error ?? null, runId],
  );
}

/**
 * 列出某工作流的运行历史(创建时间倒序)。
 *
 * @returns 运行行数组(供历史列表渲染);不含节点。
 */
export async function listWorkflowRunsByDefinition(
  userId: string,
  definitionId: string,
  limit = 100,
): Promise<WorkflowRunRow[]> {
  const { rows } = await getDbPool().query(
    `SELECT id, user_id, workflow_definition_id, chat_session_id, client_id,
            title, status, input, error, created_at, updated_at
       FROM workflow_runs
       WHERE user_id = $1 AND workflow_definition_id = $2
       ORDER BY created_at DESC
       LIMIT $3`,
    [userId, definitionId, Math.min(Math.max(limit, 1), 500)],
  );
  return rows as WorkflowRunRow[];
}
