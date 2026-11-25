import { type DbQueryable, getDbPool } from '#infrastructure/db-pool';
import { USER_CUSTOM_SKILL_FROM } from './custom-skills-repository.js';
import type { SkillBundle } from '#shared/types';
import type pg from 'pg';
import crypto from 'node:crypto';
import { getActiveUserSkillSubscriptionIdUsing } from './skill-subscriptions-repository.js';

const SKILL_BUNDLE_SELECT_COLUMNS = `
  b.id,
  b.user_id,
  b.name,
  b.description,
  COALESCE(
    (
      -- 技能被删除后 skill_bundle_items 里的关联行不会被自动清理（历史遗留数据），
      -- 这里必须 join 过滤已删除技能，否则会把已删除的 skill_id 回传给前端表单，
      -- 表单据此预选中这些看不见、也点不掉的 id，一保存就被后端校验拒绝。
      SELECT array_agg(sbi.skill_id ORDER BY sbi.sort_order)
      FROM skill_bundle_items sbi
      JOIN user_custom_skills s ON s.id = sbi.skill_id AND s.deleted_at IS NULL
      WHERE sbi.bundle_id = b.id
    ),
    ARRAY[]::text[]
  ) AS skill_ids,
  b.bundle_token,
  b.visibility,
  b.created_at,
  b.updated_at,
  b.deleted_at
`;

export async function getSkillBundleWithSkillsByIdUsing(
  queryable: DbQueryable,
  id: string,
): Promise<BundleByTokenResult | undefined> {
  const { rows } = await queryable.query(
    `SELECT ${SKILL_BUNDLE_SELECT_COLUMNS}
     FROM skill_bundles b
     WHERE b.id = $1 AND b.deleted_at IS NULL`,
    [id],
  );
  if (rows.length === 0) return undefined;
  const bundle = rowToSkillBundle(rows[0] as Record<string, unknown>);
  if (bundle.skill_ids.length === 0) {
    return { bundle, skills: [] };
  }

  const { rows: skillRows } = await queryable.query(
    `SELECT s.id, s.skill_name, s.description, COALESCE(r.content_length, 0) AS content_length
     ${USER_CUSTOM_SKILL_FROM}
     WHERE s.id = ANY($1) AND s.deleted_at IS NULL`,
    [bundle.skill_ids],
  );
  const byId = new Map(
    (skillRows as Array<Record<string, unknown>>).map((row) => [
      row.id as string,
      row,
    ]),
  );
  const skills = bundle.skill_ids
    .map((skillId) => byId.get(skillId))
    .filter((row): row is Record<string, unknown> => Boolean(row))
    .map((row) => ({
      id: row.id as string,
      skill_name: row.skill_name as string,
      description: row.description as string,
      content_length: Number(row.content_length ?? 0),
    }));

  return { bundle, skills };
}

/** 把 DB 原始行（skill_ids 为 text[] / JSON 字符串或数组）规范化为 SkillBundle */
function rowToSkillBundle(row: Record<string, unknown>): SkillBundle {
  const raw = row.skill_ids;
  const skillIds = Array.isArray(raw)
    ? (raw as unknown[]).map((value) => String(value))
    : typeof raw === 'string'
      ? (JSON.parse(raw) as string[])
      : [];
  return { ...(row as unknown as SkillBundle), skill_ids: skillIds };
}

export async function getSkillBundleById(
  id: string,
  userId?: string,
): Promise<SkillBundle | undefined> {
  const params: unknown[] = [id];
  let whereClause = `WHERE b.id = $1 AND b.deleted_at IS NULL`;
  if (userId) {
    params.push(userId);
    whereClause += ` AND b.user_id = $2`;
  }
  const { rows } = await getDbPool().query(
    `SELECT ${SKILL_BUNDLE_SELECT_COLUMNS}
     FROM skill_bundles b
     ${whereClause}`,
    params,
  );
  return rows[0]
    ? rowToSkillBundle(rows[0] as Record<string, unknown>)
    : undefined;
}

async function validateBundleSkillOwnershipUsing(
  client: pg.PoolClient,
  userId: string,
  skillIds: string[],
): Promise<string[]> {
  const unique = Array.from(new Set(skillIds));
  if (unique.length === 0) throw new Error('bundle 至少包含 1 个技能');
  // 拉取这批 id 的归属/状态明细（不加任何过滤条件），以便逐个判定非法原因；
  // 不能直接 COUNT，否则只知道数量对不上、无法告诉调用方究竟是哪条 / 为什么。
  const { rows } = await client.query<{
    id: string;
    user_id: string;
    deleted_at: Date | null;
  }>(
    `SELECT id, user_id, deleted_at
       FROM user_custom_skills
      WHERE id = ANY($1)`,
    [unique],
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const invalid: string[] = [];
  for (const id of unique) {
    const row = byId.get(id);
    // 原因判定优先级：不存在 > 非本人拥有 > 已删除。
    const reason = !row
      ? '不存在'
      : row.user_id !== userId
        ? '非本人拥有'
        : row.deleted_at !== null
          ? '已删除'
          : null;
    if (reason) invalid.push(`${id}(${reason})`);
  }
  if (invalid.length > 0) {
    throw new Error(`bundle 包含非法 skill：${invalid.join('、')}`);
  }
  return unique;
}

async function replaceSkillBundleItemsUsing(
  client: pg.PoolClient,
  bundleId: string,
  skillIds: string[],
): Promise<void> {
  await client.query(`DELETE FROM skill_bundle_items WHERE bundle_id = $1`, [
    bundleId,
  ]);
  await client.query(
    `INSERT INTO skill_bundle_items (bundle_id, skill_id, sort_order)
     SELECT $1, items.skill_id, (items.ordinality - 1)::int
     FROM UNNEST($2::text[]) WITH ORDINALITY AS items(skill_id, ordinality)`,
    [bundleId, skillIds],
  );
  await client.query(
    `UPDATE skill_bundles
     SET stat_skill_count = $2,
         updated_at = NOW()
     WHERE id = $1`,
    [bundleId, skillIds.length],
  );
}

export async function createSkillBundle(
  id: string,
  userId: string,
  name: string,
  description: string,
  skillIds: string[],
): Promise<SkillBundle> {
  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    const unique = await validateBundleSkillOwnershipUsing(
      client,
      userId,
      skillIds,
    );
    await client.query(
      `INSERT INTO skill_bundles (id, user_id, name, description)
       VALUES ($1, $2, $3, $4)`,
      [id, userId, name, description],
    );
    await replaceSkillBundleItemsUsing(client, id, unique);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return (await getSkillBundleById(id, userId)) as SkillBundle;
}

export async function listUserBundles(userId: string): Promise<SkillBundle[]> {
  const { rows } = await getDbPool().query(
    `SELECT ${SKILL_BUNDLE_SELECT_COLUMNS}
     FROM skill_bundles b
     WHERE user_id = $1 AND deleted_at IS NULL
     ORDER BY created_at DESC`,
    [userId],
  );
  return (rows as Record<string, unknown>[]).map(rowToSkillBundle);
}

export async function updateSkillBundle(
  id: string,
  userId: string,
  patch: { name?: string; description?: string; skill_ids?: string[] },
): Promise<SkillBundle | undefined> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (patch.name !== undefined) {
    fields.push(`name = $${idx++}`);
    values.push(patch.name);
  }
  if (patch.description !== undefined) {
    fields.push(`description = $${idx++}`);
    values.push(patch.description);
  }
  if (fields.length === 0 && patch.skill_ids === undefined) {
    return getSkillBundleById(id, userId);
  }

  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    let exists = false;
    if (fields.length > 0) {
      fields.push(`updated_at = NOW()`);
      values.push(id, userId);
      const result = await client.query(
        `UPDATE skill_bundles SET ${fields.join(', ')}
         WHERE id = $${idx++} AND user_id = $${idx} AND deleted_at IS NULL`,
        values,
      );
      exists = (result.rowCount ?? 0) > 0;
    } else {
      const { rowCount } = await client.query(
        `SELECT 1 FROM skill_bundles
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [id, userId],
      );
      exists = (rowCount ?? 0) > 0;
    }
    if (!exists) {
      await client.query('ROLLBACK');
      return undefined;
    }
    if (patch.skill_ids !== undefined) {
      const unique = await validateBundleSkillOwnershipUsing(
        client,
        userId,
        patch.skill_ids,
      );
      // 计算被移出 bundle 的 skill：它们对本 bundle 的授权已失效，须回收「仅靠本 bundle 授权」的订阅，
      // 否则订阅记录仍 active、继续在授权查询中授予已移除的 skill 权益（与删除/取消分享同源的孤儿授权）。
      const { rows: oldItemRows } = await client.query<{ skill_id: string }>(
        `SELECT skill_id FROM skill_bundle_items WHERE bundle_id = $1`,
        [id],
      );
      const nextSkillIds = new Set(unique);
      const removedSkillIds = oldItemRows
        .map((row) => row.skill_id)
        .filter((skillId) => !nextSkillIds.has(skillId));
      await replaceSkillBundleItemsUsing(client, id, unique);
      if (removedSkillIds.length > 0) {
        await purgeBundleSourceOrphanSubscriptionsUsing(client, id, {
          skillIds: removedSkillIds,
        });
      }
      if (fields.length === 0) {
        await client.query(
          `UPDATE skill_bundles
           SET updated_at = NOW()
           WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
          [id, userId],
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return getSkillBundleById(id, userId);
}

/**
 * 回收「因某 bundle 来源失效而失去最后一个有效授权来源」的孤儿订阅，并回退对应 skill 的订阅计数。
 *
 * @param db 可执行查询的 PG 连接（模块级 pool 或事务内 client）。
 * @param bundleId 触发回收的 bundle id（被删除 / 取消分享 / 下架 / 移出 skill）。
 * @param options.subscriberId 仅回收该订阅者的订阅（用户主动退订单个 bundle）；不传则对所有订阅者生效（owner 操作 bundle）。
 * @param options.skillIds 仅回收这些 skill 的订阅来源（从 bundle 移出部分 skill）；不传则回收该 bundle 下全部 skill。
 * @returns 实际删除的 bundle 来源行数。
 * @remarks 统一「用户退订 / owner 删除 / 取消分享 / 下架 / 移出 skill」五条回收路径，避免多份重复 CTE 日后漂移。
 *   流程：先删命中的订阅指向该 bundle 的来源行，再删除因此再无「有效 bundle 来源」且无 direct source 的孤儿订阅，
 *   最后回退 skill 订阅计数。判定「是否还有有效来源」时正向 JOIN skill_bundles + skill_bundle_items，要求来源
 *   bundle 存活（deleted_at IS NULL）、可分享（visibility IN link_shared/shared）且仍包含该 skill——任一不满足即
 *   视为死来源，故历史软删 / 取消分享 / 移出 skill 遗留的来源行都不再误判为「仍有来源」而挡住回收。
 *   用正向判定而非「排除本 bundle 后是否还有行」，可绕开「同一 WITH 内数据修改子句共享起始快照、看不到
 *   deleted_sources 删除效果」的坑（死来源即便仍在快照里也不满足有效条件）。
 */
async function purgeBundleSourceOrphanSubscriptionsUsing(
  db: DbQueryable,
  bundleId: string,
  options: { subscriberId?: string; skillIds?: string[] } = {},
): Promise<number> {
  const { rows } = await db.query(
    `WITH deleted_sources AS (
       DELETE FROM user_skill_subscription_bundle_sources src
       USING user_skill_subscriptions sub
       WHERE src.subscription_id = sub.id
         AND src.bundle_id = $1
         AND ($2::text IS NULL OR sub.subscriber_id = $2)
         AND ($3::text[] IS NULL OR sub.skill_id = ANY($3))
       RETURNING src.subscription_id
     ),
     removable AS (
       SELECT sub.id, sub.skill_id
       FROM user_skill_subscriptions sub
       JOIN deleted_sources ds ON ds.subscription_id = sub.id
       WHERE sub.has_direct_source = false
         AND NOT EXISTS (
           SELECT 1
           FROM user_skill_subscription_bundle_sources other
           JOIN skill_bundles b ON b.id = other.bundle_id
           JOIN skill_bundle_items sbi
             ON sbi.bundle_id = b.id AND sbi.skill_id = sub.skill_id
           WHERE other.subscription_id = sub.id
             AND other.bundle_id <> $1
             AND b.deleted_at IS NULL
             AND b.visibility IN ('link_shared', 'shared')
         )
     ),
     deleted_subscriptions AS (
       DELETE FROM user_skill_subscriptions sub
       USING removable r
       WHERE sub.id = r.id
       RETURNING sub.skill_id
     ),
     decrements AS (
       SELECT skill_id, COUNT(*)::int AS count
       FROM deleted_subscriptions
       GROUP BY skill_id
     ),
     updated AS (
       UPDATE user_custom_skills s
       SET stat_subscriber_count = GREATEST(0, s.stat_subscriber_count - d.count),
           updated_at = NOW()
       FROM decrements d
       WHERE s.id = d.skill_id
       RETURNING s.id
     )
     SELECT (SELECT COUNT(*)::int FROM deleted_sources) AS deleted_source_count`,
    [bundleId, options.subscriberId ?? null, options.skillIds ?? null],
  );
  return Number(
    (rows[0] as { deleted_source_count: number }).deleted_source_count,
  );
}

export async function deleteSkillBundle(
  id: string,
  userId: string,
): Promise<boolean> {
  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query(
      `UPDATE skill_bundles SET deleted_at = NOW(), bundle_token = NULL, visibility = 'private'
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [id, userId],
    );
    const deleted = (rowCount ?? 0) > 0;
    if (deleted) {
      // 软删 bundle 不触发 FK 的 ON DELETE CASCADE，必须显式回收「仅靠该 bundle 授权」的订阅，
      // 否则订阅记录仍 active、继续在授权查询中授予权益（本次审计的孤儿授权路径根因）。
      await purgeBundleSourceOrphanSubscriptionsUsing(client, id);
    }
    await client.query('COMMIT');
    return deleted;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function shareSkillBundle(
  id: string,
  userId: string,
  token: string,
): Promise<SkillBundle | undefined> {
  const { rowCount } = await getDbPool().query(
    `UPDATE skill_bundles
     SET visibility = CASE WHEN visibility = 'shared' THEN 'shared' ELSE 'link_shared' END,
         bundle_token = COALESCE(bundle_token, $3),
         updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
     RETURNING id`,
    [id, userId, token],
  );
  if ((rowCount ?? 0) === 0) return undefined;
  return getSkillBundleById(id, userId);
}

export async function unshareSkillBundle(
  id: string,
  userId: string,
): Promise<SkillBundle | undefined> {
  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ visibility: string }>(
      `UPDATE skill_bundles
       SET visibility = CASE WHEN visibility = 'shared' THEN 'shared' ELSE 'private' END,
           bundle_token = CASE WHEN visibility = 'shared' THEN bundle_token ELSE NULL END,
           updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       RETURNING visibility`,
      [id, userId],
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return undefined;
    }
    // 取消分享后 bundle 转为 private（不可再通过链接订阅）时，回收「仅靠该 bundle 授权」的既有订阅，
    // 与删除 bundle 同源——否则已订阅者会无限期保留对已转私有 skill 的访问。仍为 shared（已上架）则不动。
    if (rows[0]?.visibility === 'private') {
      await purgeBundleSourceOrphanSubscriptionsUsing(client, id);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return getSkillBundleById(id, userId);
}

export async function publishSkillBundle(
  id: string,
  userId: string,
  token: string,
): Promise<SkillBundle | undefined> {
  const { rowCount } = await getDbPool().query(
    `UPDATE skill_bundles
     SET visibility = 'shared',
         bundle_token = COALESCE(bundle_token, $3),
         updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
     RETURNING id`,
    [id, userId, token],
  );
  if ((rowCount ?? 0) === 0) return undefined;
  return getSkillBundleById(id, userId);
}

export async function unpublishSkillBundle(
  id: string,
  userId: string,
): Promise<SkillBundle | undefined> {
  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ visibility: string }>(
      `UPDATE skill_bundles
       SET visibility = CASE WHEN bundle_token IS NULL THEN 'private' ELSE 'link_shared' END,
           updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       RETURNING visibility`,
      [id, userId],
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return undefined;
    }
    // 下架后若无分享 token 则 bundle 转为 private：回收既有订阅（与取消分享/删除同源）；
    // 若仍保留 token 退级为 link_shared（仍可通过链接订阅），则不回收。
    if (rows[0]?.visibility === 'private') {
      await purgeBundleSourceOrphanSubscriptionsUsing(client, id);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return getSkillBundleById(id, userId);
}

export interface BundleByTokenResult {
  bundle: SkillBundle;
  skills: Array<{
    id: string;
    skill_name: string;
    description: string;
    content_length: number;
  }>;
}

export async function getBundleByToken(
  token: string,
): Promise<BundleByTokenResult | undefined> {
  const { rows } = await getDbPool().query(
    `SELECT ${SKILL_BUNDLE_SELECT_COLUMNS}
     FROM skill_bundles b
     WHERE b.bundle_token = $1 AND b.deleted_at IS NULL AND b.visibility IN ('link_shared', 'shared')`,
    [token],
  );
  if (rows.length === 0) return undefined;
  const row = rows[0] as Record<string, unknown>;
  const bundle = rowToSkillBundle(row);
  if (bundle.skill_ids.length === 0) {
    return {
      bundle,
      skills: [],
    };
  }
  const { rows: skillRows } = await getDbPool().query(
    `SELECT s.id, s.skill_name, s.description, COALESCE(r.content_length, 0) AS content_length
     ${USER_CUSTOM_SKILL_FROM}
     WHERE s.id = ANY($1) AND s.deleted_at IS NULL`,
    [bundle.skill_ids],
  );
  // 保留 bundle.skill_ids 原始顺序
  const byId = new Map(
    (skillRows as Array<Record<string, unknown>>).map((r) => [
      r.id as string,
      r,
    ]),
  );
  const skills = bundle.skill_ids
    .map((sid) => byId.get(sid))
    .filter((x): x is Record<string, unknown> => Boolean(x))
    .map((r) => ({
      id: r.id as string,
      skill_name: r.skill_name as string,
      description: r.description as string,
      content_length: Number(r.content_length ?? 0),
    }));
  return {
    bundle,
    skills,
  };
}

export interface SubscribeToBundleResult {
  subscribedCount: number;
  skippedCount: number;
  subscriptionIds: string[];
}

export async function subscribeToBundle(
  subscriberId: string,
  token: string,
): Promise<SubscribeToBundleResult | null> {
  const info = await getBundleByToken(token);
  if (!info) return null;
  if (info.bundle.user_id === subscriberId) return null; // 非自订

  const skillIdsValid = info.skills.map((s) => s.id);
  // getBundleByToken 内部已过滤失效（deleted_at / workflow 快照）。
  // bundle.skill_ids 原始长度 - 有效长度 = 静默跳过的失效条数
  let skippedCount = info.bundle.skill_ids.length - skillIdsValid.length;
  let subscribedCount = 0;
  const subscriptionIds: string[] = [];
  const insertedSkillIds = new Set<string>();

  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    // 关闭 TOCTOU：getBundleByToken 在事务外读，token 校验到写入之间 bundle 可能被并发
    // 删除/取消分享/下架。这里在事务内对 bundle 行加 FOR SHARE 锁并重查「存活且仍可分享」，
    // 与并发的 deleteSkillBundle/unshare/unpublish（FOR NO KEY UPDATE）串行化，杜绝
    // 「读到存活 → 被失效并 purge → 再插入订阅」复活已被回收的孤儿授权。
    const { rowCount: stillSubscribable } = await client.query(
      `SELECT 1 FROM skill_bundles
       WHERE id = $1 AND deleted_at IS NULL AND visibility IN ('link_shared', 'shared')
       FOR SHARE`,
      [info.bundle.id],
    );
    if (!stillSubscribable) {
      await client.query('ROLLBACK');
      return null;
    }
    for (const skillId of skillIdsValid) {
      const subId = crypto.randomUUID();
      const { rows, rowCount } = await client.query(
        `INSERT INTO user_skill_subscriptions
           (id, subscriber_id, skill_id, has_direct_source, source_kind)
         VALUES ($1, $2, $3, false, 'bundle_share')
         ON CONFLICT (subscriber_id, skill_id) DO UPDATE SET
           enabled = true,
           status = 'active',
           expires_at = NULL,
           source_kind = CASE
             WHEN user_skill_subscriptions.source_kind IN ('invite', 'bundle_invite')
               THEN user_skill_subscriptions.source_kind
             ELSE 'bundle_share'
           END
         RETURNING id, (xmax = 0) AS is_insert`,
        [subId, subscriberId, skillId],
      );
      const row = rows[0] as { id: string; is_insert: boolean } | undefined;
      const subscriptionId =
        rowCount && rowCount > 0 && row
          ? row.id
          : await getActiveUserSkillSubscriptionIdUsing(
              client,
              subscriberId,
              skillId,
            );
      if (!subscriptionId) {
        skippedCount++;
        continue;
      }
      await client.query(
        `INSERT INTO user_skill_subscription_bundle_sources
           (subscription_id, bundle_id)
         VALUES ($1, $2)
         ON CONFLICT (subscription_id, bundle_id) DO NOTHING`,
        [subscriptionId, info.bundle.id],
      );
      if (row?.is_insert) {
        subscribedCount++;
        subscriptionIds.push(subscriptionId);
        insertedSkillIds.add(skillId);
      } else {
        skippedCount++;
      }
    }
    if (insertedSkillIds.size > 0) {
      await client.query(
        `UPDATE user_custom_skills
         SET stat_subscriber_count = stat_subscriber_count + 1,
             updated_at = NOW()
         WHERE id = ANY($1)`,
        [Array.from(insertedSkillIds)],
      );
    }
    await client.query('COMMIT');
    return { subscribedCount, skippedCount, subscriptionIds };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function unsubscribeFromBundle(
  bundleId: string,
  subscriberId: string,
): Promise<number> {
  // 用户主动退订单个 bundle：复用统一回收逻辑，仅限本订阅者、限本 bundle 的来源。
  return purgeBundleSourceOrphanSubscriptionsUsing(getDbPool(), bundleId, {
    subscriberId,
  });
}
