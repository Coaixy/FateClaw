import type { UserCustomSkill, TextSkillBundleFile } from '#shared/types';
import {
  prepareSkillContent,
  readSkillMarkdownMetadata,
} from '@fateclaw/contracts/skills/content';
import { deriveSkillCategory } from '#modules/skills/category-map';
import { getDbPool, type DbQueryable } from '#infrastructure/db-pool';
import { insertSkillContentRevision } from './skill-content-repository.js';
import { SkillRevisionConflictError } from '#modules/skills/skill-errors';

export const USER_CUSTOM_SKILL_SUMMARY_COLUMNS = `
  s.id,
  s.user_id,
  s.skill_name,
  s.dir_name,
  s.description,
  s.category,
  s.version,
  CASE WHEN r.id IS NULL THEN s.bundle_uri ELSE 'db://skill-content-revisions/' || r.id END AS bundle_uri,
  r.id AS revision_id,
  r.format_version,
  COALESCE(r.checksum, s.checksum) AS checksum,
  COALESCE(r.content_length, 0) AS content_length,
  s.install_status,
  s.acl,
  s.billing_policy,
  s.audit_metadata,
  s.visibility,
  s.share_token,
  s.enabled,
  s.stat_subscriber_count,
  s.stat_view_count,
  s.created_at,
  s.updated_at,
  s.deleted_at
`;

export const USER_CUSTOM_SKILL_SELECT_COLUMNS = `${USER_CUSTOM_SKILL_SUMMARY_COLUMNS}, COALESCE(r.files, '[]'::jsonb) AS files`;

function hydrateUserCustomSkillContent<T extends Partial<UserCustomSkill>>(
  skill: T,
): T {
  const files = skill.files ?? [];
  return {
    ...skill,
    files,
    content_length:
      skill.content_length ??
      files.reduce((sum, file) => sum + file.content.length, 0),
  };
}

export function hydrateUserCustomSkillRows<T extends Partial<UserCustomSkill>>(
  rows: T[],
): T[] {
  return rows.map(hydrateUserCustomSkillContent);
}

export const USER_CUSTOM_SKILL_FROM = `FROM user_custom_skills s
  LEFT JOIN skill_content_revisions r ON r.skill_id = s.id AND r.id = s.current_revision_id`;

export interface CreateUserCustomSkillInput {
  id: string;
  user_id: string;
  skill_name: string;
  dir_name: string;
  files: TextSkillBundleFile[];
  /** 作者显式指定的门类；缺省时由 deriveSkillCategory 自动归类。 */
  category?: string;
}

export async function createUserCustomSkill(
  skill: CreateUserCustomSkillInput,
): Promise<UserCustomSkill> {
  const bundle = prepareSkillContent(skill.files);
  const skillFile = bundle.files.find((file) => file.path === 'SKILL.md');
  const metadata = readSkillMarkdownMetadata(
    skillFile?.content ?? '',
    skill.skill_name,
  );
  const displayName = metadata.name || skill.skill_name;
  // 混合分类：作者显式指定优先，否则按「名称+描述」自动归类（兜底 '通用'）。
  const category =
    skill.category ?? deriveSkillCategory(displayName, metadata.description);
  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO user_custom_skills
         (id, user_id, skill_name, dir_name, description, category,
          version, install_status, acl, billing_policy, audit_metadata, visibility)
       VALUES ($1, $2, $3, $4, $5, $6, '1.0.0', 'installed',
               '{}'::jsonb, '{}'::jsonb, $7::jsonb, 'private')`,
      [
        skill.id,
        skill.user_id,
        displayName,
        skill.dir_name,
        metadata.description,
        category,
        JSON.stringify({
          source: 'api',
          created_at: new Date().toISOString(),
        }),
      ],
    );
    const revision = await insertSkillContentRevision(client, skill.id, bundle);
    await client.query(
      'UPDATE user_custom_skills SET current_revision_id = $1 WHERE id = $2',
      [revision.revisionId, skill.id],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return (await getUserCustomSkillById(skill.id)) as UserCustomSkill;
}

export async function getUserCustomSkills(
  userId: string,
  includeContent = true,
): Promise<UserCustomSkill[]> {
  const { rows } = await getDbPool().query(
    `SELECT ${includeContent ? USER_CUSTOM_SKILL_SELECT_COLUMNS : USER_CUSTOM_SKILL_SUMMARY_COLUMNS}
     ${USER_CUSTOM_SKILL_FROM}
     WHERE s.user_id = $1 AND s.deleted_at IS NULL
     ORDER BY s.created_at DESC`,
    [userId],
  );
  return hydrateUserCustomSkillRows(rows as UserCustomSkill[]);
}

export async function getUserCustomSkill(
  id: string,
  userId: string,
): Promise<UserCustomSkill | undefined> {
  const { rows } = await getDbPool().query(
    `SELECT ${USER_CUSTOM_SKILL_SELECT_COLUMNS}
     ${USER_CUSTOM_SKILL_FROM}
     WHERE s.id = $1 AND s.user_id = $2 AND s.deleted_at IS NULL`,
    [id, userId],
  );
  return rows[0]
    ? hydrateUserCustomSkillContent(rows[0] as UserCustomSkill)
    : undefined;
}

export async function getUserCustomSkillByIdUsing(
  db: DbQueryable,
  id: string,
): Promise<UserCustomSkill | undefined> {
  const { rows } = await db.query(
    `SELECT ${USER_CUSTOM_SKILL_SELECT_COLUMNS}
     ${USER_CUSTOM_SKILL_FROM}
     WHERE s.id = $1 AND s.deleted_at IS NULL`,
    [id],
  );
  return rows[0]
    ? hydrateUserCustomSkillContent(rows[0] as UserCustomSkill)
    : undefined;
}

export async function getUserCustomSkillById(
  id: string,
): Promise<UserCustomSkill | undefined> {
  return getUserCustomSkillByIdUsing(getDbPool(), id);
}

export async function updateUserCustomSkill(
  id: string,
  userId: string,
  updates: Partial<
    Pick<UserCustomSkill, 'skill_name' | 'dir_name' | 'files' | 'category'>
  > & { base_revision_id: string | null },
): Promise<UserCustomSkill | undefined> {
  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<UserCustomSkill>(
      `SELECT ${USER_CUSTOM_SKILL_SELECT_COLUMNS}
       ${USER_CUSTOM_SKILL_FROM}
       WHERE s.id = $1 AND s.user_id = $2 AND s.deleted_at IS NULL
       FOR UPDATE OF s`,
      [id, userId],
    );
    const current = rows[0];
    if (!current) {
      await client.query('ROLLBACK');
      return undefined;
    }
    if (
      updates.base_revision_id === undefined ||
      (current.revision_id ?? null) !== updates.base_revision_id
    ) {
      throw new SkillRevisionConflictError();
    }
    const files = updates.files ?? current.files;
    if (!files?.length)
      throw new Error('Skill 尚未完成内容导入，请先恢复完整文件');
    const content = prepareSkillContent(files);
    const fallbackName = updates.skill_name ?? current.skill_name;
    const metadata = updates.files
      ? readSkillMarkdownMetadata(
          content.files.find((file) => file.path === 'SKILL.md')!.content,
          fallbackName,
        )
      : { name: fallbackName, description: current.description };
    const revision = await insertSkillContentRevision(client, id, content);
    await client.query(
      `UPDATE user_custom_skills
       SET skill_name = $1, description = $2, category = $3, dir_name = $4,
           current_revision_id = $5, install_status = 'installed', updated_at = NOW()
       WHERE id = $6 AND user_id = $7 AND deleted_at IS NULL`,
      [
        metadata.name || fallbackName,
        metadata.description,
        updates.category ?? current.category,
        updates.dir_name ?? current.dir_name,
        revision.revisionId,
        id,
        userId,
      ],
    );
    await client.query(
      `UPDATE skill_content_imports
      SET status = 'complete', error_code = NULL, checked_at = NOW() WHERE skill_id = $1`,
      [id],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return getUserCustomSkill(id, userId);
}

export async function deleteUserCustomSkill(
  id: string,
  userId: string,
): Promise<boolean> {
  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query(
      `UPDATE user_custom_skills
       SET deleted_at = NOW()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [id, userId],
    );
    if ((rowCount ?? 0) > 0) {
      // 技能删除后同步清理它在各 bundle 里的关联行，并重算受影响 bundle 的
      // stat_skill_count；否则关联行会一直留存成孤儿数据。
      await client.query(
        `WITH removed AS (
           DELETE FROM skill_bundle_items WHERE skill_id = $1
           RETURNING bundle_id
         )
         UPDATE skill_bundles b
         SET stat_skill_count = (
               SELECT COUNT(*) FROM skill_bundle_items i WHERE i.bundle_id = b.id
             ),
             updated_at = NOW()
         FROM (SELECT DISTINCT bundle_id FROM removed) r
         WHERE b.id = r.bundle_id`,
        [id],
      );
    }
    await client.query('COMMIT');
    return (rowCount ?? 0) > 0;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function toggleUserCustomSkill(
  id: string,
  userId: string,
): Promise<UserCustomSkill | undefined> {
  const { rowCount } = await getDbPool().query(
    `UPDATE user_custom_skills SET enabled = NOT enabled, updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
     RETURNING id`,
    [id, userId],
  );
  if ((rowCount ?? 0) === 0) return undefined;
  return getUserCustomSkill(id, userId);
}

export async function setUserCustomSkillAdminState(
  id: string,
  updates: {
    enabled?: boolean;
    visibility?: UserCustomSkill['visibility'];
    shareToken?: string | null;
  },
): Promise<UserCustomSkill | undefined> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  if (updates.enabled !== undefined) {
    fields.push(`enabled = $${paramIdx++}`);
    values.push(updates.enabled);
  }

  if (updates.visibility !== undefined) {
    const visibilityParamIdx = paramIdx++;
    values.push(updates.visibility);
    const shareTokenParamIdx = paramIdx++;
    values.push(updates.shareToken ?? null);
    fields.push(`visibility = $${visibilityParamIdx}`);
    fields.push(`share_token = CASE
      WHEN $${visibilityParamIdx} = 'private' THEN NULL
      WHEN $${visibilityParamIdx} IN ('link_shared', 'shared')
        THEN COALESCE(share_token, $${shareTokenParamIdx})
      ELSE share_token
    END`);
  }

  if (fields.length === 0) {
    return getUserCustomSkillById(id);
  }

  fields.push('updated_at = NOW()');
  values.push(id);

  const { rows } = await getDbPool().query(
    `UPDATE user_custom_skills
     SET ${fields.join(', ')}
     WHERE id = $${paramIdx} AND deleted_at IS NULL
     RETURNING id`,
    values,
  );
  if (rows.length === 0) return undefined;
  return getUserCustomSkillById(id);
}

export async function getUserCustomSkillCount(userId: string): Promise<number> {
  const { rows } = await getDbPool().query(
    `SELECT COUNT(*) as cnt
     FROM user_custom_skills s
     WHERE user_id = $1 AND deleted_at IS NULL`,
    [userId],
  );
  return Number((rows[0] as { cnt: string }).cnt);
}

export async function shareUserCustomSkill(
  id: string,
  userId: string,
  shareToken: string,
): Promise<UserCustomSkill | undefined> {
  const { rowCount } = await getDbPool().query(
    `UPDATE user_custom_skills
     SET visibility = CASE WHEN visibility = 'shared' THEN 'shared' ELSE 'link_shared' END,
         share_token = COALESCE(share_token, $3),
         updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
     RETURNING id`,
    [id, userId, shareToken],
  );
  if ((rowCount ?? 0) === 0) return undefined;
  return getUserCustomSkill(id, userId);
}

export async function unshareUserCustomSkill(
  id: string,
  userId: string,
): Promise<UserCustomSkill | undefined> {
  const { rowCount } = await getDbPool().query(
    `UPDATE user_custom_skills
     SET visibility = CASE WHEN visibility = 'shared' THEN 'shared' ELSE 'private' END,
         share_token = CASE WHEN visibility = 'shared' THEN share_token ELSE NULL END,
         updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
     RETURNING id`,
    [id, userId],
  );
  if ((rowCount ?? 0) === 0) return undefined;
  return getUserCustomSkill(id, userId);
}

export async function publishUserCustomSkill(
  id: string,
  userId: string,
  shareToken: string,
): Promise<UserCustomSkill | undefined> {
  const { rowCount } = await getDbPool().query(
    `UPDATE user_custom_skills
     SET visibility = 'shared',
         share_token = COALESCE(share_token, $3),
         updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
     RETURNING id`,
    [id, userId, shareToken],
  );
  if ((rowCount ?? 0) === 0) return undefined;
  return getUserCustomSkill(id, userId);
}

export async function unpublishUserCustomSkill(
  id: string,
  userId: string,
): Promise<UserCustomSkill | undefined> {
  const { rowCount } = await getDbPool().query(
    `UPDATE user_custom_skills
     SET visibility = CASE WHEN share_token IS NULL THEN 'private' ELSE 'link_shared' END,
         updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
     RETURNING id`,
    [id, userId],
  );
  if ((rowCount ?? 0) === 0) return undefined;
  return getUserCustomSkill(id, userId);
}

export async function getSkillByShareToken(
  token: string,
): Promise<UserCustomSkill | undefined> {
  const { rows } = await getDbPool().query(
    `SELECT ${USER_CUSTOM_SKILL_SELECT_COLUMNS}
     ${USER_CUSTOM_SKILL_FROM}
      WHERE s.share_token = $1 AND s.deleted_at IS NULL AND s.visibility IN ('link_shared', 'shared')`,
    [token],
  );
  return rows[0]
    ? hydrateUserCustomSkillContent(rows[0] as UserCustomSkill)
    : undefined;
}
