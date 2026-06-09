import type {
  SimpleModelPolicy,
  SimpleWorkflowKind,
  SimpleWorkflowPaipanSkill,
  SimpleWorkflowPreset,
} from '../../shared/types.js';
import { getDbPool } from '../db-pool.js';

type SimpleWorkflowPresetRow = Omit<
  SimpleWorkflowPreset,
  'paipan_input_defaults' | 'model_policy' | 'skill_bundle_ids'
> & {
  paipan_input_defaults: unknown;
  model_policy: unknown;
  skill_bundle_ids: unknown;
};

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
  };
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
           prompt_template = $10,
           sort_order = $11,
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
        input.skillBundleIds ?? current.skill_bundle_ids,
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
