import crypto from 'node:crypto';
import type pg from 'pg';

import type {
  SimpleModelPolicy,
  SimpleWorkflowKind,
  SimpleWorkflowPaipanSkill,
  SimpleWorkflowPreset,
} from '../../shared/types.js';
import {
  calculateTextSkillBundleChecksum,
  readTextSkillBundleFiles,
  writeTextSkillBundleFiles,
} from '../../modules/skills/text-skill-bundle-store.js';
import { getDbPool } from '../db-pool.js';

type SimpleWorkflowPresetRow = Omit<
  SimpleWorkflowPreset,
  | 'paipan_input_defaults'
  | 'model_policy'
  | 'skill_bundle_ids'
  | 'skill_ids'
  | 'skill_snapshot_ids'
> & {
  paipan_input_defaults: unknown;
  model_policy: unknown;
  skill_bundle_ids: unknown;
  skill_ids: unknown;
  skill_snapshot_ids: unknown;
};

interface WorkflowSkillSourceRow {
  skill_id: string;
  user_id: string;
  skill_name: string;
  dir_name: string;
  description: string;
  bundle_uri: string;
}

const WORKFLOW_SNAPSHOT_AUDIT_SOURCE = 'simple_workflow_snapshot';

export interface SimpleWorkflowPresetUpdateInput {
  id: string;
  name?: string;
  enabled?: boolean;
  isDefault?: boolean;
  entryTitle?: string;
  entryDescription?: string;
  paipanInputDefaults?: Record<string, unknown>;
  modelPolicy?: SimpleModelPolicy;
  skillBundleIds?: string[];
  skillIds?: string[];
  promptTemplate?: string;
  sortOrder?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeModelPolicy(value: unknown): SimpleModelPolicy {
  if (!isRecord(value)) {
    return { mode: 'system-default' };
  }
  const mode =
    value.mode === 'system-default' ||
    value.mode === 'user-current' ||
    value.mode === 'fixed'
      ? value.mode
      : 'system-default';
  const thinkingLevel =
    value.thinkingLevel === 'off' ||
    value.thinkingLevel === 'low' ||
    value.thinkingLevel === 'medium' ||
    value.thinkingLevel === 'high' ||
    value.thinkingLevel === 'xhigh'
      ? value.thinkingLevel
      : undefined;
  const fixedModelId =
    typeof value.fixedModelId === 'string' && value.fixedModelId.trim()
      ? value.fixedModelId.trim()
      : undefined;
  return {
    mode,
    fixedModelId,
    thinkingLevel,
  };
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function mapSimpleWorkflowPresetRow(
  row: SimpleWorkflowPresetRow,
): SimpleWorkflowPreset {
  return {
    ...row,
    kind: row.kind as SimpleWorkflowKind,
    paipan_skill: row.paipan_skill as SimpleWorkflowPaipanSkill,
    paipan_input_defaults: isRecord(row.paipan_input_defaults)
      ? row.paipan_input_defaults
      : {},
    model_policy: normalizeModelPolicy(row.model_policy),
    skill_bundle_ids: normalizeStringArray(row.skill_bundle_ids),
    skill_ids: normalizeStringArray(row.skill_ids),
    skill_snapshot_ids: normalizeStringArray(row.skill_snapshot_ids),
  };
}

function workflowSnapshotSkillId(
  presetId: string,
  sourceSkillId: string,
): string {
  const hash = crypto
    .createHash('sha256')
    .update(`${presetId}:${sourceSkillId}`)
    .digest('hex')
    .slice(0, 16);
  return `workflow-snapshot-${hash}`;
}

function workflowSnapshotDirName(
  presetId: string,
  sourceDirName: string,
  sourceSkillId: string,
  contentChecksum: string,
): string {
  const hash = crypto
    .createHash('sha256')
    .update(`${presetId}:${sourceSkillId}:${contentChecksum}`)
    .digest('hex')
    .slice(0, 10);
  return `workflow-${sourceDirName}-${hash}`.slice(0, 120);
}

async function listWorkflowSkillSources(
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

async function deleteWorkflowSnapshotSkills(
  client: pg.PoolClient,
  presetId: string,
  exceptIds: string[],
): Promise<void> {
  await client.query(
    `UPDATE user_custom_skills
     SET deleted_at = NOW(),
         enabled = false,
         updated_at = NOW()
     WHERE audit_metadata->>'source' = $1
       AND audit_metadata->>'workflow_preset_id' = $2
       AND NOT (id = ANY($3::text[]))
       AND deleted_at IS NULL`,
    [WORKFLOW_SNAPSHOT_AUDIT_SOURCE, presetId, exceptIds],
  );
}

async function upsertWorkflowSnapshotSkill(args: {
  client: pg.PoolClient;
  presetId: string;
  source: WorkflowSkillSourceRow;
}): Promise<string> {
  const snapshotId = workflowSnapshotSkillId(
    args.presetId,
    args.source.skill_id,
  );
  const files = readTextSkillBundleFiles(args.source.bundle_uri);
  if (!files.some((file) => file.path === 'SKILL.md')) {
    throw new Error(
      `workflow 绑定的 skill 缺少 SKILL.md：${args.source.skill_name}`,
    );
  }
  const contentChecksum = calculateTextSkillBundleChecksum(files);
  const dirName = workflowSnapshotDirName(
    args.presetId,
    args.source.dir_name,
    args.source.skill_id,
    contentChecksum,
  );
  const bundle = writeTextSkillBundleFiles({
    skillId: snapshotId,
    ownerId: args.source.user_id,
    dirName,
    fallbackSkillName: args.source.skill_name,
    files,
  });
  const auditMetadata = {
    source: WORKFLOW_SNAPSHOT_AUDIT_SOURCE,
    workflow_preset_id: args.presetId,
    source_skill_id: args.source.skill_id,
    source_checksum: bundle.checksum,
    snapshotted_at: new Date().toISOString(),
  };
  await args.client.query(
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
      args.source.user_id,
      args.source.skill_name,
      dirName,
      args.source.description,
      bundle.bundleUri,
      bundle.checksum,
      JSON.stringify(auditMetadata),
    ],
  );
  return snapshotId;
}

async function createWorkflowSkillSnapshots(
  client: pg.PoolClient,
  presetId: string,
  skillIds: string[],
): Promise<string[]> {
  const normalizedSkillIds = Array.from(new Set(skillIds));
  const sources = await listWorkflowSkillSources(client, normalizedSkillIds);
  if (sources.length !== normalizedSkillIds.length) {
    throw new Error('workflow 绑定的 skill 不存在或不可用');
  }
  const sourceSkillIds = new Set<string>();
  const snapshotIds: string[] = [];
  for (const source of sources) {
    if (sourceSkillIds.has(source.skill_id)) continue;
    sourceSkillIds.add(source.skill_id);
    snapshotIds.push(
      await upsertWorkflowSnapshotSkill({ client, presetId, source }),
    );
  }
  await deleteWorkflowSnapshotSkills(client, presetId, snapshotIds);
  return snapshotIds;
}

/**
 * 列出所有简易模式 workflow preset。
 *
 * @returns 按入口类型、排序值和 ID 稳定排序的 preset 列表。
 */
export async function listSimpleWorkflowPresets(): Promise<
  SimpleWorkflowPreset[]
> {
  const { rows } = await getDbPool().query(
    `SELECT *
     FROM simple_workflow_presets
     ORDER BY kind ASC, sort_order ASC, id ASC`,
  );
  return (rows as SimpleWorkflowPresetRow[]).map(mapSimpleWorkflowPresetRow);
}

/**
 * 读取指定类型当前启用的默认简易 workflow preset。
 *
 * @param kind 简易模式入口类型。
 * @returns 找到时返回 preset，否则返回 undefined。
 */
export async function getDefaultSimpleWorkflowPreset(
  kind: SimpleWorkflowKind,
): Promise<SimpleWorkflowPreset | undefined> {
  const { rows } = await getDbPool().query(
    `SELECT *
     FROM simple_workflow_presets
     WHERE kind = $1 AND enabled = true AND is_default = true
     ORDER BY sort_order ASC, id ASC
     LIMIT 1`,
    [kind],
  );
  return rows[0]
    ? mapSimpleWorkflowPresetRow(rows[0] as SimpleWorkflowPresetRow)
    : undefined;
}

/**
 * 读取单个简易 workflow preset。
 *
 * @param id preset 主键。
 * @returns 找到时返回 preset，否则返回 undefined。
 */
export async function getSimpleWorkflowPreset(
  id: string,
): Promise<SimpleWorkflowPreset | undefined> {
  const { rows } = await getDbPool().query(
    `SELECT * FROM simple_workflow_presets WHERE id = $1`,
    [id],
  );
  return rows[0]
    ? mapSimpleWorkflowPresetRow(rows[0] as SimpleWorkflowPresetRow)
    : undefined;
}

/**
 * 更新简易 workflow preset。
 *
 * @param input 可更新字段；未传入的字段保持不变。
 * @returns 更新后的 preset；不存在时返回 undefined。
 */
export async function updateSimpleWorkflowPreset(
  input: SimpleWorkflowPresetUpdateInput,
): Promise<SimpleWorkflowPreset | undefined> {
  const current = await getSimpleWorkflowPreset(input.id);
  if (!current) {
    return undefined;
  }

  const nextIsDefault = input.isDefault ?? current.is_default;
  const nextSkillIds = input.skillIds ?? current.skill_ids;
  const shouldRefreshSnapshots = input.skillIds !== undefined;
  const nextSkillBundleIds = shouldRefreshSnapshots
    ? []
    : input.skillBundleIds ?? current.skill_bundle_ids;
  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    if (nextIsDefault) {
      await client.query(
        `UPDATE simple_workflow_presets
         SET is_default = false, updated_at = NOW()
         WHERE kind = $1 AND id <> $2`,
        [current.kind, input.id],
      );
    }

    const nextSkillSnapshotIds = shouldRefreshSnapshots
      ? await createWorkflowSkillSnapshots(client, input.id, nextSkillIds)
      : current.skill_snapshot_ids;

    const { rows } = await client.query(
      `UPDATE simple_workflow_presets
       SET name = $2,
           enabled = $3,
           is_default = $4,
           entry_title = $5,
           entry_description = $6,
           paipan_input_defaults = $7::jsonb,
           model_policy = $8::jsonb,
           skill_bundle_ids = $9::text[],
           skill_ids = $10::text[],
           skill_snapshot_ids = $11::text[],
           prompt_template = $12,
           sort_order = $13,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        input.id,
        input.name ?? current.name,
        input.enabled ?? current.enabled,
        nextIsDefault,
        input.entryTitle ?? current.entry_title,
        input.entryDescription ?? current.entry_description,
        JSON.stringify(
          input.paipanInputDefaults ?? current.paipan_input_defaults,
        ),
        JSON.stringify(input.modelPolicy ?? current.model_policy),
        nextSkillBundleIds,
        nextSkillIds,
        nextSkillSnapshotIds,
        input.promptTemplate ?? current.prompt_template,
        input.sortOrder ?? current.sort_order,
      ],
    );
    await client.query('COMMIT');
    return rows[0]
      ? mapSimpleWorkflowPresetRow(rows[0] as SimpleWorkflowPresetRow)
      : undefined;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
