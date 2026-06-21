import crypto from 'node:crypto';

import type pg from 'pg';

import type {
  WorkflowEdgeDto,
  WorkflowGraphDto,
  WorkflowNodeDto,
} from '@fateclaw/contracts/workflow';

import {
  calculateTextSkillBundleChecksum,
  readTextSkillBundleFiles,
  writeTextSkillBundleFiles,
} from '../../modules/skills/text-skill-bundle-store.js';
import { getDbPool } from '../db-pool.js';

/** 工作流定义表行;graph 为 JSONB,读出为 unknown 待归一。 */
interface WorkflowDefinitionRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  graph: unknown;
  enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** 归一后的工作流定义记录(graph 已归一为 { nodes, edges })。 */
export interface WorkflowDefinitionRecord
  extends Omit<WorkflowDefinitionRow, 'graph'> {
  graph: WorkflowGraphDto;
}

/** SELECT 公共列(避免把 deleted_at 等内部列带出)。 */
const SELECT_COLUMNS =
  'id, user_id, name, description, graph, enabled, sort_order, created_at, updated_at';

/** 绑定 skill 不存在/不可用时抛出的错误,供服务层映射为 400。 */
export class WorkflowSkillUnavailableError extends Error {
  constructor() {
    super('workflow 绑定的 skill 不存在或不可用');
    this.name = 'WorkflowSkillUnavailableError';
  }
}

/**
 * 归一 graph:接受 { nodes, edges };节点须带字符串 type 判别字段,边须有 source/target 字符串;
 * 其余丢弃。非对象/缺字段时落为空图。
 *
 * @remarks 入库时由路由 zod 校验过结构,这里是读出兜底,避免脏 JSONB 影响下游。
 */
function normalizeGraph(value: unknown): WorkflowGraphDto {
  if (!value || typeof value !== 'object') return { nodes: [], edges: [] };
  const raw = value as { nodes?: unknown; edges?: unknown };
  const nodes = Array.isArray(raw.nodes)
    ? raw.nodes.filter(
        (node): node is WorkflowNodeDto =>
          !!node &&
          typeof node === 'object' &&
          typeof (node as { type?: unknown }).type === 'string',
      )
    : [];
  const edges = Array.isArray(raw.edges)
    ? raw.edges.filter(
        (edge): edge is WorkflowEdgeDto =>
          !!edge &&
          typeof edge === 'object' &&
          typeof (edge as { source?: unknown }).source === 'string' &&
          typeof (edge as { target?: unknown }).target === 'string',
      )
    : [];
  return { nodes, edges };
}

function mapRow(row: WorkflowDefinitionRow): WorkflowDefinitionRecord {
  return { ...row, graph: normalizeGraph(row.graph) };
}

// ───────────────────────────────────────────────────────────────
// skill 快照:保存工作流时为 AI 步绑定的 skill 冻结一份私有副本,运行时用副本而非活 skill,
// 防止卦师之后改 skill 把已保存的工作流改坏(行为漂移)。
//
// 复用与简易模式相同的 audit source 'simple_workflow_snapshot',使这些快照行被
// skills 列表/市场/导出的既有过滤自动隐藏;用 audit_metadata.workflow_definition_id
// 区分归属与清理范围,和简易模式的 workflow_preset_id 互不干扰。
// ───────────────────────────────────────────────────────────────
const WORKFLOW_SNAPSHOT_AUDIT_SOURCE = 'simple_workflow_snapshot';

interface WorkflowSkillSourceRow {
  skill_id: string;
  user_id: string;
  skill_name: string;
  dir_name: string;
  description: string;
  bundle_uri: string;
}

/** 快照 skill 的确定性 id:同一定义 + 同一源 skill 始终映射到同一快照。 */
function snapshotSkillId(definitionId: string, sourceSkillId: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(`${definitionId}:${sourceSkillId}`)
    .digest('hex')
    .slice(0, 16);
  return `workflow-def-snapshot-${hash}`;
}

/** 快照目录名:带内容校验和,内容变化时目录名变化。 */
function snapshotDirName(
  definitionId: string,
  sourceDirName: string,
  sourceSkillId: string,
  contentChecksum: string,
): string {
  const hash = crypto
    .createHash('sha256')
    .update(`${definitionId}:${sourceSkillId}:${contentChecksum}`)
    .digest('hex')
    .slice(0, 10);
  return `workflow-def-${sourceDirName}-${hash}`.slice(0, 120);
}

/** 拉取可作为快照来源的 skill(排除快照自身,避免快照套快照)。 */
async function listSnapshotSources(
  client: pg.PoolClient,
  skillIds: string[],
): Promise<WorkflowSkillSourceRow[]> {
  if (skillIds.length === 0) return [];
  const { rows } = await client.query<WorkflowSkillSourceRow>(
    `SELECT
       s.id AS skill_id,
       s.user_id,
       s.skill_name,
       s.dir_name,
       s.description,
       s.bundle_uri
     FROM user_custom_skills s
     WHERE s.id = ANY($1::text[])
       AND s.deleted_at IS NULL
       AND s.install_status = 'installed'
       AND COALESCE(s.audit_metadata->>'source', '') <> $2
     ORDER BY array_position($1::text[], s.id), s.dir_name`,
    [skillIds, WORKFLOW_SNAPSHOT_AUDIT_SOURCE],
  );
  return rows;
}

/** 软删该定义下、不在本次保留集合内的历史快照。 */
async function deleteOrphanSnapshots(
  client: pg.PoolClient,
  definitionId: string,
  exceptIds: string[],
): Promise<void> {
  await client.query(
    `UPDATE user_custom_skills
     SET deleted_at = NOW(),
         enabled = false,
         updated_at = NOW()
     WHERE audit_metadata->>'source' = $1
       AND audit_metadata->>'workflow_definition_id' = $2
       AND NOT (id = ANY($3::text[]))
       AND deleted_at IS NULL`,
    [WORKFLOW_SNAPSHOT_AUDIT_SOURCE, definitionId, exceptIds],
  );
}

/** 为单个源 skill 写入/更新快照副本,返回快照 id。 */
async function upsertSnapshotSkill(
  client: pg.PoolClient,
  definitionId: string,
  source: WorkflowSkillSourceRow,
): Promise<string> {
  const snapshotId = snapshotSkillId(definitionId, source.skill_id);
  const files = readTextSkillBundleFiles(source.bundle_uri);
  if (!files.some((file) => file.path === 'SKILL.md')) {
    throw new Error(`workflow 绑定的 skill 缺少 SKILL.md：${source.skill_name}`);
  }
  const contentChecksum = calculateTextSkillBundleChecksum(files);
  const dirName = snapshotDirName(
    definitionId,
    source.dir_name,
    source.skill_id,
    contentChecksum,
  );
  const bundle = writeTextSkillBundleFiles({
    skillId: snapshotId,
    ownerId: source.user_id,
    dirName,
    fallbackSkillName: source.skill_name,
    files,
  });
  const auditMetadata = {
    source: WORKFLOW_SNAPSHOT_AUDIT_SOURCE,
    workflow_definition_id: definitionId,
    source_skill_id: source.skill_id,
    source_checksum: bundle.checksum,
    snapshotted_at: new Date().toISOString(),
  };
  await client.query(
    `INSERT INTO user_custom_skills
       (id, user_id, skill_name, dir_name, description,
        version, bundle_uri, checksum, install_status, acl, billing_policy,
        audit_metadata, visibility, enabled)
     VALUES ($1, $2, $3, $4, $5, '1.0.0', $6, $7, 'installed',
             '{}'::jsonb, '{}'::jsonb, $8::jsonb, 'private', true)
     ON CONFLICT (id) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       skill_name = EXCLUDED.skill_name,
       dir_name = EXCLUDED.dir_name,
       description = EXCLUDED.description,
       bundle_uri = EXCLUDED.bundle_uri,
       checksum = EXCLUDED.checksum,
       install_status = 'installed',
       audit_metadata = EXCLUDED.audit_metadata,
       visibility = 'private',
       enabled = true,
       deleted_at = NULL,
       updated_at = NOW()`,
    [
      snapshotId,
      source.user_id,
      source.skill_name,
      dirName,
      source.description,
      bundle.bundleUri,
      bundle.checksum,
      JSON.stringify(auditMetadata),
    ],
  );
  return snapshotId;
}

/** 把图里所有 AI 节点的 skillSnapshotIds 重写为给定映射(无映射则置空),边保持不变。 */
function rewriteGraphSnapshotIds(
  graph: WorkflowGraphDto,
  snapshotIdBySkillId: Map<string, string> | null,
): WorkflowGraphDto {
  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.type === 'ai'
        ? {
            ...node,
            skillSnapshotIds: snapshotIdBySkillId
              ? node.skillIds
                  .map((id) => snapshotIdBySkillId.get(id))
                  .filter((id): id is string => Boolean(id))
              : [],
          }
        : node,
    ),
  };
}

/**
 * 为定义图里所有 AI 节点生成/刷新 skill 快照,并回填每个 AI 节点的 skillSnapshotIds。
 *
 * @remarks 必须在事务内调用。绑定 skill 不存在/不可用时抛 WorkflowSkillUnavailableError,
 *          由上层回滚。返回的图中,AI 节点的 skillSnapshotIds 已按其 skillIds 顺序映射。
 */
async function applyDefinitionSkillSnapshots(
  client: pg.PoolClient,
  definitionId: string,
  graph: WorkflowGraphDto,
): Promise<WorkflowGraphDto> {
  const allSkillIds = Array.from(
    new Set(
      graph.nodes.flatMap((node) =>
        node.type === 'ai' ? node.skillIds : [],
      ),
    ),
  );

  // 没有任何绑定 skill:清掉该定义历史快照,AI 节点快照置空。
  if (allSkillIds.length === 0) {
    await deleteOrphanSnapshots(client, definitionId, []);
    return rewriteGraphSnapshotIds(graph, null);
  }

  const sources = await listSnapshotSources(client, allSkillIds);
  if (sources.length !== allSkillIds.length) {
    throw new WorkflowSkillUnavailableError();
  }

  const snapshotIdBySkillId = new Map<string, string>();
  for (const source of sources) {
    if (snapshotIdBySkillId.has(source.skill_id)) continue;
    snapshotIdBySkillId.set(
      source.skill_id,
      await upsertSnapshotSkill(client, definitionId, source),
    );
  }
  await deleteOrphanSnapshots(
    client,
    definitionId,
    Array.from(snapshotIdBySkillId.values()),
  );

  return rewriteGraphSnapshotIds(graph, snapshotIdBySkillId);
}

/** 创建工作流定义的入参。 */
export interface CreateWorkflowDefinitionInput {
  userId: string;
  name: string;
  description: string;
  graph: WorkflowGraphDto;
  enabled: boolean;
  sortOrder: number;
}

/** 更新工作流定义的入参;未传字段保持不变。 */
export interface UpdateWorkflowDefinitionInput {
  name?: string;
  description?: string;
  graph?: WorkflowGraphDto;
  enabled?: boolean;
  sortOrder?: number;
}

/**
 * 列出某卦师名下全部未删除的工作流定义。
 *
 * @param userId 工作流归属用户 ID。
 * @returns 按 sort_order 升序、创建时间倒序排列的定义列表。
 */
export async function listWorkflowDefinitionsByUserId(
  userId: string,
): Promise<WorkflowDefinitionRecord[]> {
  const { rows } = await getDbPool().query(
    `SELECT ${SELECT_COLUMNS}
     FROM workflow_definitions
     WHERE user_id = $1 AND deleted_at IS NULL
     ORDER BY sort_order ASC, created_at DESC`,
    [userId],
  );
  return (rows as WorkflowDefinitionRow[]).map(mapRow);
}

/**
 * 读取某卦师名下的单个工作流定义。
 *
 * @param id 定义主键。
 * @param userId 工作流归属用户 ID(owner 隔离)。
 * @returns 找到时返回记录,否则 undefined。
 */
export async function getWorkflowDefinition(
  id: string,
  userId: string,
): Promise<WorkflowDefinitionRecord | undefined> {
  const { rows } = await getDbPool().query(
    `SELECT ${SELECT_COLUMNS}
     FROM workflow_definitions
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId],
  );
  return rows[0] ? mapRow(rows[0] as WorkflowDefinitionRow) : undefined;
}

/**
 * 创建工作流定义(事务内同时为 AI 步生成 skill 快照)。
 *
 * @param input 创建入参。
 * @returns 新建的定义记录(steps 已含快照 id)。
 */
export async function createWorkflowDefinition(
  input: CreateWorkflowDefinitionInput,
): Promise<WorkflowDefinitionRecord> {
  const id = `workflow-${crypto.randomUUID()}`;
  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    const graph = await applyDefinitionSkillSnapshots(client, id, input.graph);
    const { rows } = await client.query(
      `INSERT INTO workflow_definitions
         (id, user_id, name, description, graph, enabled, sort_order)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       RETURNING ${SELECT_COLUMNS}`,
      [
        id,
        input.userId,
        input.name,
        input.description,
        JSON.stringify(graph),
        input.enabled,
        input.sortOrder,
      ],
    );
    await client.query('COMMIT');
    return mapRow(rows[0] as WorkflowDefinitionRow);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * 更新工作流定义(整体覆盖语义;未传字段保持不变;事务内刷新 skill 快照)。
 *
 * @param id 定义主键。
 * @param userId 工作流归属用户 ID(owner 隔离)。
 * @param input 更新入参。
 * @returns 更新后的记录;不存在或无权限时返回 undefined。
 */
export async function updateWorkflowDefinition(
  id: string,
  userId: string,
  input: UpdateWorkflowDefinitionInput,
): Promise<WorkflowDefinitionRecord | undefined> {
  const current = await getWorkflowDefinition(id, userId);
  if (!current) return undefined;

  const nextName = input.name ?? current.name;
  const nextDescription = input.description ?? current.description;
  const nextGraphInput = input.graph ?? current.graph;
  const nextEnabled = input.enabled ?? current.enabled;
  const nextSortOrder = input.sortOrder ?? current.sort_order;

  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    const graph = await applyDefinitionSkillSnapshots(client, id, nextGraphInput);
    const { rows } = await client.query(
      `UPDATE workflow_definitions
       SET name = $3,
           description = $4,
           graph = $5::jsonb,
           enabled = $6,
           sort_order = $7,
           updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       RETURNING ${SELECT_COLUMNS}`,
      [
        id,
        userId,
        nextName,
        nextDescription,
        JSON.stringify(graph),
        nextEnabled,
        nextSortOrder,
      ],
    );
    await client.query('COMMIT');
    return rows[0] ? mapRow(rows[0] as WorkflowDefinitionRow) : undefined;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * 软删除工作流定义。
 *
 * @param id 定义主键。
 * @param userId 工作流归属用户 ID(owner 隔离)。
 * @returns 实际删除到记录返回 true,否则 false(不存在/无权限/已删)。
 */
export async function softDeleteWorkflowDefinition(
  id: string,
  userId: string,
): Promise<boolean> {
  const { rowCount } = await getDbPool().query(
    `UPDATE workflow_definitions
     SET deleted_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId],
  );
  return (rowCount ?? 0) > 0;
}
