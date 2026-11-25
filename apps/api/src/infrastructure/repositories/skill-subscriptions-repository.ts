import { type DbQueryable, getDbPool } from '#infrastructure/db-pool';
import type { UserSkillSubscription, UserCustomSkill } from '#shared/types';
import {
  getSkillByShareToken,
  USER_CUSTOM_SKILL_SELECT_COLUMNS,
  USER_CUSTOM_SKILL_SUMMARY_COLUMNS,
  hydrateUserCustomSkillRows,
} from './custom-skills-repository.js';

export async function getActiveUserSkillSubscriptionIdUsing(
  queryable: DbQueryable,
  subscriberId: string,
  skillId: string,
): Promise<string | null> {
  const { rows } = await queryable.query(
    `SELECT id
     FROM user_skill_subscriptions
     WHERE subscriber_id = $1
       AND skill_id = $2
       AND status = 'active'
       AND (expires_at IS NULL OR expires_at > NOW())
     LIMIT 1`,
    [subscriberId, skillId],
  );
  return (rows[0] as { id?: string } | undefined)?.id ?? null;
}

export async function subscribeToSkill(
  subscriptionId: string,
  subscriberId: string,
  shareToken: string,
): Promise<UserSkillSubscription | null> {
  // 查找分享的 skill
  const skill = await getSkillByShareToken(shareToken);
  if (!skill) return null;
  // 不能订阅自己的 skill
  if (skill.user_id === subscriberId) return null;

  const { rows } = await getDbPool().query(
    `INSERT INTO user_skill_subscriptions (id, subscriber_id, skill_id, source_kind)
     VALUES ($1, $2, $3, 'share')
     ON CONFLICT (subscriber_id, skill_id) DO UPDATE SET
       enabled = true,
       has_direct_source = true,
       source_kind = CASE
         WHEN user_skill_subscriptions.source_kind IN ('invite', 'bundle_invite')
           THEN user_skill_subscriptions.source_kind
         ELSE 'share'
       END
     RETURNING *, (xmax = 0) AS is_insert`,
    [subscriptionId, subscriberId, skill.id],
  );
  if (rows[0] && (rows[0] as Record<string, unknown>).is_insert) {
    await getDbPool().query(
      `UPDATE user_custom_skills
       SET stat_subscriber_count = stat_subscriber_count + 1,
           updated_at = NOW()
       WHERE id = $1`,
      [skill.id],
    );
  }
  return rows[0] as UserSkillSubscription;
}

export async function unsubscribeFromSkill(
  subscriptionId: string,
  subscriberId: string,
): Promise<boolean> {
  const client = await getDbPool().connect();
  try {
    await client.query('BEGIN');
    const { rows: subscriptionRows } = await client.query(
      `SELECT id, skill_id, has_direct_source
       FROM user_skill_subscriptions
       WHERE id = $1 AND subscriber_id = $2
       FOR UPDATE`,
      [subscriptionId, subscriberId],
    );
    const subscription = subscriptionRows[0] as
      { id: string; skill_id: string; has_direct_source: boolean } | undefined;
    if (!subscription) {
      await client.query('ROLLBACK');
      return false;
    }

    const { rows: sourceRows } = await client.query(
      `SELECT 1
       FROM user_skill_subscription_bundle_sources
       WHERE subscription_id = $1
       LIMIT 1`,
      [subscriptionId],
    );

    if (subscription.has_direct_source && sourceRows.length > 0) {
      // 仍有 Bundle 授权时只移除 direct source，不能删除整条订阅。
      await client.query(
        `UPDATE user_skill_subscriptions
         SET has_direct_source = false
         WHERE id = $1`,
        [subscriptionId],
      );
      await client.query('COMMIT');
      return true;
    }

    if (!subscription.has_direct_source && sourceRows.length > 0) {
      // 没有直接来源、但仍挂着 Bundle 授权来源：这条订阅本该通过退订对应
      // Bundle 处理，维持原状（正常不会走到这条分支，只是防御性保留）。
      await client.query('COMMIT');
      return true;
    }

    // 没有任何 Bundle 授权来源了——要么本来就是纯直接订阅，要么是
    // has_direct_source 已被清空、Bundle 来源也已清空的孤儿记录（例如历史遗留
    // 数据）。两种情况都应该被彻底删除，否则"取消订阅"会在孤儿记录上
    // 静默空转，前端显示成功但列表纹丝不动。
    await client.query('DELETE FROM user_skill_subscriptions WHERE id = $1', [
      subscriptionId,
    ]);
    await client.query(
      `UPDATE user_custom_skills
       SET stat_subscriber_count = GREATEST(0, stat_subscriber_count - 1),
           updated_at = NOW()
       WHERE id = $1`,
      [subscription.skill_id],
    );
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function toggleSubscription(
  subscriptionId: string,
  subscriberId: string,
): Promise<boolean | null> {
  const { rows } = await getDbPool().query(
    `UPDATE user_skill_subscriptions SET enabled = NOT enabled
     WHERE id = $1 AND subscriber_id = $2
     RETURNING enabled`,
    [subscriptionId, subscriberId],
  );
  if (rows.length === 0) return null;
  return (rows[0] as { enabled: boolean }).enabled;
}

export async function getSubscribedSkills(
  subscriberId: string,
  includeContent = true,
): Promise<
  (UserCustomSkill & {
    subscription_id: string;
    subscription_enabled: boolean;
    has_direct_source: boolean;
    source_bundles: Array<{ id: string; name: string }>;
  })[]
> {
  const { rows } = await getDbPool().query(
    `SELECT ${includeContent ? USER_CUSTOM_SKILL_SELECT_COLUMNS : USER_CUSTOM_SKILL_SUMMARY_COLUMNS},
            sub.id as subscription_id,
            sub.enabled as subscription_enabled,
            sub.has_direct_source,
            COALESCE(
              (
                SELECT jsonb_agg(
                  jsonb_build_object('id', b.id, 'name', b.name)
                  ORDER BY src.created_at ASC
                )
                FROM user_skill_subscription_bundle_sources src
                JOIN skill_bundles b ON b.id = src.bundle_id
                WHERE src.subscription_id = sub.id
              ),
              '[]'::jsonb
            ) AS source_bundles
     FROM user_skill_subscriptions sub
     JOIN user_custom_skills s ON s.id = sub.skill_id
     LEFT JOIN skill_content_revisions r ON r.skill_id = s.id AND r.id = s.current_revision_id
     WHERE sub.subscriber_id = $1
       AND sub.status = 'active'
       AND (sub.expires_at IS NULL OR sub.expires_at > NOW())
       AND s.deleted_at IS NULL
       AND (
         s.visibility IN ('link_shared', 'shared')
         OR sub.source_kind IN ('bundle_share', 'invite', 'bundle_invite')
       )`,
    [subscriberId],
  );
  return hydrateUserCustomSkillRows(
    rows as (UserCustomSkill & {
      subscription_id: string;
      subscription_enabled: boolean;
      has_direct_source: boolean;
      source_bundles: Array<{ id: string; name: string }>;
    })[],
  );
}

/** 对外开放 API 的有效 skill 列表项：只暴露 id / 名称 / 简介 / 来源，隐去 dir/checksum 等内部字段。 */
export interface OpenApiEffectiveSkill {
  id: string;
  name: string;
  description: string | null;
  /** 'self' = 自有；'subscribed' = 订阅而来。 */
  source: 'self' | 'subscribed';
}

/**
 * 列出用户「有效可用」的自定义 skill（自有且启用 + 订阅且启用），供对外开放 API 的
 * `GET /api/v1/skills` 用，让调用方拿到建会话 `fateclaw.skills` 所需的 skill id(UUID)。
 *
 * **口径必须与 agent-runtime `queryEffectiveUserSkills` 完全一致**——那是建会话授权的权威来源
 * （runtime 用 `queryEffectiveUserSkillsByIds` 按同口径取交集，无权/未启用的 id 会被静默丢弃）。
 * 因此此处刻意**不**复用 `getUserCustomSkills` / `getSubscribedSkills`：后者为站内 UI 服务，
 * 会返回未启用 / 未安装的 skill，口径更宽，拿来列表会出现「填进去却被丢弃」的幽灵项。
 * 改动授权口径时，本函数与 agent-runtime 那份需**同步**。
 *
 * @param userId 平台用户 ID。
 * @returns 该用户当前可填入 `fateclaw.skills` 的 skill（按名称升序，不含 dir/checksum 等内部字段）。
 */
export async function listEffectiveUserSkillsForOpenApi(
  userId: string,
): Promise<OpenApiEffectiveSkill[]> {
  if (!userId) return [];
  const { rows } = await getDbPool().query(
    `SELECT s.id, s.skill_name AS name, s.description, 'self' AS source
       FROM user_custom_skills s
      WHERE s.user_id = $1
        AND s.enabled = true
        AND s.deleted_at IS NULL
        AND s.install_status = 'installed'
     UNION ALL
     SELECT s.id, s.skill_name AS name, s.description, 'subscribed' AS source
       FROM user_skill_subscriptions sub
       JOIN user_custom_skills s ON s.id = sub.skill_id
      WHERE sub.subscriber_id = $1
        AND sub.enabled = true
        AND sub.status = 'active'
        AND (sub.expires_at IS NULL OR sub.expires_at > NOW())
        AND s.deleted_at IS NULL
        AND (
          s.visibility IN ('link_shared', 'shared')
          OR sub.source_kind IN ('bundle_share', 'invite', 'bundle_invite')
        )
        AND s.install_status = 'installed'
      ORDER BY name ASC`,
    [userId],
  );
  return rows as OpenApiEffectiveSkill[];
}
