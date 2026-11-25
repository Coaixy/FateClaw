import type { SkillComment, SkillCommentStatus } from '#shared/types';
import { getDbPool } from '#infrastructure/db-pool';

/** 管理端评论审核列表行，包含提交者基础审计信息。 */
export interface AdminSkillCommentRow extends SkillComment {
  skill_name: string;
  user_phone: string | null;
}

/**
 * 查询管理端 Skill 评论审核列表。
 */
export async function listSkillCommentsForAdmin(filter: {
  status?: SkillCommentStatus;
  skillId?: string;
  limit?: number;
}): Promise<AdminSkillCommentRow[]> {
  const conditions = ['1=1'];
  const params: unknown[] = [];
  if (filter.status) {
    params.push(filter.status);
    conditions.push(`c.status = $${params.length}`);
  }
  if (filter.skillId) {
    params.push(filter.skillId);
    conditions.push(`c.skill_id = $${params.length}`);
  }
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 200);
  params.push(limit);

  const { rows } = await getDbPool().query(
    `SELECT
       c.id,
       c.skill_id,
       s.skill_name,
       c.user_id,
       u.phone AS user_phone,
       c.body,
       c.status,
       c.pinned,
       c.reviewed_by,
       c.reviewed_at,
       c.created_at,
       c.updated_at
     FROM skill_comments c
     JOIN user_custom_skills s ON s.id = c.skill_id
     LEFT JOIN users u ON u.id = c.user_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY
       CASE c.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
       c.pinned DESC,
       c.created_at DESC
     LIMIT $${params.length}`,
    params,
  );
  return rows as AdminSkillCommentRow[];
}

/**
 * 管理员审核 Skill 评论。
 */
export async function reviewSkillCommentForAdmin(input: {
  id: string;
  status: SkillCommentStatus;
  reviewedBy: string;
}): Promise<AdminSkillCommentRow | null> {
  const pinnedSql = input.status === 'approved' ? 'pinned' : 'false';
  const { rows } = await getDbPool().query(
    `WITH updated AS (
       UPDATE skill_comments
       SET status = $2,
           pinned = ${pinnedSql},
           reviewed_by = $3,
           reviewed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *
     )
     SELECT
       c.id,
       c.skill_id,
       s.skill_name,
       c.user_id,
       u.phone AS user_phone,
       c.body,
       c.status,
       c.pinned,
       c.reviewed_by,
       c.reviewed_at,
       c.created_at,
       c.updated_at
     FROM updated c
     JOIN user_custom_skills s ON s.id = c.skill_id
     LEFT JOIN users u ON u.id = c.user_id`,
    [input.id, input.status, input.reviewedBy],
  );
  return (rows[0] as AdminSkillCommentRow | undefined) ?? null;
}

/**
 * 管理员设置已通过评论的置顶状态。
 *
 * @returns 评论不存在或未通过审核时返回 null。
 */
export async function setSkillCommentPinnedForAdmin(
  id: string,
  pinned: boolean,
): Promise<AdminSkillCommentRow | null> {
  const { rows } = await getDbPool().query(
    `WITH updated AS (
       UPDATE skill_comments
       SET pinned = $2,
           updated_at = NOW()
       WHERE id = $1 AND status = 'approved'
       RETURNING *
     )
     SELECT
       c.id,
       c.skill_id,
       s.skill_name,
       c.user_id,
       u.phone AS user_phone,
       c.body,
       c.status,
       c.pinned,
       c.reviewed_by,
       c.reviewed_at,
       c.created_at,
       c.updated_at
     FROM updated c
     JOIN user_custom_skills s ON s.id = c.skill_id
     LEFT JOIN users u ON u.id = c.user_id`,
    [id, pinned],
  );
  return (rows[0] as AdminSkillCommentRow | undefined) ?? null;
}
