import type {
  SkillAccessInvite,
  UserCustomSkill,
  SkillAccessInviteTargetType,
} from '#shared/types';
import {
  type BundleByTokenResult,
  getSkillBundleById,
  getSkillBundleWithSkillsByIdUsing,
} from './skill-bundles-repository.js';
import {
  getUserCustomSkill,
  getUserCustomSkillByIdUsing,
} from './custom-skills-repository.js';
import { getDbPool, type DbQueryable } from '#infrastructure/db-pool';
import crypto from 'node:crypto';
import { getActiveUserSkillSubscriptionIdUsing } from './skill-subscriptions-repository.js';

/** 私密授权链接当前能否继续领取的状态。 */
export type SkillAccessInviteStatus =
  'active' | 'expired' | 'revoked' | 'used_up';

/**
 * 私密授权链接预览结果。
 *
 * @remarks skill 与 bundle 二选一，取决于 invite.target_type。
 */
export interface SkillAccessInvitePreviewResult {
  invite: SkillAccessInvite;
  status: SkillAccessInviteStatus;
  skill: UserCustomSkill | null;
  bundle: BundleByTokenResult | null;
}

/** 领取私密授权链接后的领域状态。 */
export type RedeemSkillAccessInviteStatus =
  'redeemed' | 'invalid' | 'expired' | 'revoked' | 'used_up' | 'own_target';

/**
 * 领取私密授权链接的结果。
 *
 * @remarks 非 redeemed 状态只用于路由层返回对应错误文案。
 */
export interface RedeemSkillAccessInviteResult {
  status: RedeemSkillAccessInviteStatus;
  targetType: SkillAccessInviteTargetType | null;
  subscribedCount: number;
  skippedCount: number;
  subscriptionIds: string[];
}

function rowToSkillAccessInvite(
  row: Record<string, unknown>,
): SkillAccessInvite {
  return row as unknown as SkillAccessInvite;
}

/**
 * 解析私密授权链接状态。
 *
 * @param invite 私密授权链接行。
 * @param now 用于测试或事务内复用的当前时间。
 * @returns 当前链接是否仍可领取。
 */
export function resolveSkillAccessInviteStatus(
  invite: SkillAccessInvite,
  now = new Date(),
): SkillAccessInviteStatus {
  if (invite.revoked_at) return 'revoked';
  if (
    invite.expires_at &&
    new Date(invite.expires_at).getTime() <= now.getTime()
  ) {
    return 'expired';
  }
  if (invite.redeemed_count >= invite.max_redemptions) return 'used_up';
  return 'active';
}

/**
 * 创建私密授权链接所需的 repository 输入。
 */
export interface CreateSkillAccessInviteInput {
  id: string;
  creatorId: string;
  targetType: SkillAccessInviteTargetType;
  targetId: string;
  token: string;
  maxRedemptions: number;
  expiresAt: string | null;
  note: string;
}

/**
 * 为作者自有 Skill 或 Bundle 创建私密授权链接。
 *
 * @returns 目标不存在或不属于作者时返回 null。
 */
export async function createSkillAccessInvite(
  input: CreateSkillAccessInviteInput,
): Promise<SkillAccessInvite | null> {
  const target =
    input.targetType === 'skill'
      ? await getUserCustomSkill(input.targetId, input.creatorId)
      : await getSkillBundleById(input.targetId, input.creatorId);
  if (!target) return null;

  const { rows } = await getDbPool().query(
    `INSERT INTO skill_access_invites (
       id, creator_id, target_type, target_id, token,
       max_redemptions, expires_at, note
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      input.id,
      input.creatorId,
      input.targetType,
      input.targetId,
      input.token,
      input.maxRedemptions,
      input.expiresAt,
      input.note,
    ],
  );
  return rowToSkillAccessInvite(rows[0] as Record<string, unknown>);
}

/**
 * 作者侧授权链接列表筛选条件。
 */
export interface ListSkillAccessInvitesFilter {
  targetType?: SkillAccessInviteTargetType;
  targetId?: string;
}

/**
 * 列出作者创建的私密授权链接。
 */
export async function listSkillAccessInvites(
  creatorId: string,
  filter: ListSkillAccessInvitesFilter = {},
): Promise<SkillAccessInvite[]> {
  const conditions = ['creator_id = $1'];
  const params: unknown[] = [creatorId];
  if (filter.targetType) {
    params.push(filter.targetType);
    conditions.push(`target_type = $${params.length}`);
  }
  if (filter.targetId) {
    params.push(filter.targetId);
    conditions.push(`target_id = $${params.length}`);
  }

  const { rows } = await getDbPool().query(
    `SELECT *
     FROM skill_access_invites
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC`,
    params,
  );
  return (rows as Array<Record<string, unknown>>).map(rowToSkillAccessInvite);
}

/**
 * 撤销作者创建的私密授权链接。
 *
 * @returns 链接不存在或不属于作者时返回 null。
 */
export async function revokeSkillAccessInvite(
  inviteId: string,
  creatorId: string,
): Promise<SkillAccessInvite | null> {
  const { rows } = await getDbPool().query(
    `UPDATE skill_access_invites
     SET revoked_at = COALESCE(revoked_at, NOW())
     WHERE id = $1 AND creator_id = $2
     RETURNING *`,
    [inviteId, creatorId],
  );
  return rows[0]
    ? rowToSkillAccessInvite(rows[0] as Record<string, unknown>)
    : null;
}

async function getSkillAccessInviteByTokenUsing(
  queryable: DbQueryable,
  token: string,
  forUpdate = false,
): Promise<SkillAccessInvite | null> {
  const { rows } = await queryable.query(
    `SELECT *
     FROM skill_access_invites
     WHERE token = $1
     ${forUpdate ? 'FOR UPDATE' : ''}`,
    [token],
  );
  return rows[0]
    ? rowToSkillAccessInvite(rows[0] as Record<string, unknown>)
    : null;
}

/**
 * 读取私密授权链接预览。
 *
 * @returns 链接或目标不存在时返回 null。
 */
export async function getSkillAccessInvitePreviewByToken(
  token: string,
): Promise<SkillAccessInvitePreviewResult | null> {
  const invite = await getSkillAccessInviteByTokenUsing(getDbPool(), token);
  if (!invite) return null;
  const status = resolveSkillAccessInviteStatus(invite);

  if (invite.target_type === 'skill') {
    const skill = await getUserCustomSkillByIdUsing(
      getDbPool(),
      invite.target_id,
    );
    if (!skill) return null;
    return { invite, status, skill, bundle: null };
  }

  const bundle = await getSkillBundleWithSkillsByIdUsing(
    getDbPool(),
    invite.target_id,
  );
  if (!bundle) return null;
  return { invite, status, skill: null, bundle };
}

/**
 * 领取私密授权链接，并写入用户 Skill 订阅。
 */
export async function redeemSkillAccessInvite(
  subscriberId: string,
  token: string,
): Promise<RedeemSkillAccessInviteResult> {
  const client = await getDbPool().connect();
  const inactiveResult = (
    status: RedeemSkillAccessInviteStatus,
    targetType: SkillAccessInviteTargetType | null,
  ): RedeemSkillAccessInviteResult => ({
    status,
    targetType,
    subscribedCount: 0,
    skippedCount: 0,
    subscriptionIds: [],
  });

  try {
    await client.query('BEGIN');
    const invite = await getSkillAccessInviteByTokenUsing(client, token, true);
    if (!invite) {
      await client.query('ROLLBACK');
      return inactiveResult('invalid', null);
    }

    const inviteStatus = resolveSkillAccessInviteStatus(invite);
    if (inviteStatus !== 'active') {
      await client.query('ROLLBACK');
      return inactiveResult(inviteStatus, invite.target_type);
    }

    if (invite.target_type === 'skill') {
      const skill = await getUserCustomSkillByIdUsing(client, invite.target_id);
      if (!skill) {
        await client.query('ROLLBACK');
        return inactiveResult('invalid', 'skill');
      }
      if (skill.user_id === subscriberId) {
        await client.query('ROLLBACK');
        return inactiveResult('own_target', 'skill');
      }

      const subscriptionId = crypto.randomUUID();
      const { rows } = await client.query(
        `INSERT INTO user_skill_subscriptions
           (id, subscriber_id, skill_id, has_direct_source, source_kind)
         VALUES ($1, $2, $3, true, 'invite')
         ON CONFLICT (subscriber_id, skill_id) DO UPDATE SET
           enabled = true,
           status = 'active',
           expires_at = NULL,
           has_direct_source = true,
           source_kind = 'invite'
         RETURNING id, (xmax = 0) AS is_insert`,
        [subscriptionId, subscriberId, skill.id],
      );
      const row = rows[0] as { id: string; is_insert: boolean };
      if (row.is_insert) {
        await client.query(
          `UPDATE user_custom_skills
           SET stat_subscriber_count = stat_subscriber_count + 1,
               updated_at = NOW()
           WHERE id = $1`,
          [skill.id],
        );
      }
      await client.query(
        `UPDATE skill_access_invites
         SET redeemed_count = redeemed_count + 1
         WHERE id = $1`,
        [invite.id],
      );
      await client.query('COMMIT');
      return {
        status: 'redeemed',
        targetType: 'skill',
        subscribedCount: row.is_insert ? 1 : 0,
        skippedCount: row.is_insert ? 0 : 1,
        subscriptionIds: [row.id],
      };
    }

    const bundle = await getSkillBundleWithSkillsByIdUsing(
      client,
      invite.target_id,
    );
    if (!bundle) {
      await client.query('ROLLBACK');
      return inactiveResult('invalid', 'bundle');
    }
    if (bundle.bundle.user_id === subscriberId) {
      await client.query('ROLLBACK');
      return inactiveResult('own_target', 'bundle');
    }

    const skillIdsValid = bundle.skills.map((skill) => skill.id);
    let skippedCount = bundle.bundle.skill_ids.length - skillIdsValid.length;
    let subscribedCount = 0;
    const subscriptionIds: string[] = [];
    const insertedSkillIds = new Set<string>();

    for (const skillId of skillIdsValid) {
      const subId = crypto.randomUUID();
      const { rows, rowCount } = await client.query(
        `INSERT INTO user_skill_subscriptions
           (id, subscriber_id, skill_id, has_direct_source, source_kind)
         VALUES ($1, $2, $3, false, 'bundle_invite')
         ON CONFLICT (subscriber_id, skill_id) DO UPDATE SET
           enabled = true,
           status = 'active',
           expires_at = NULL,
           source_kind = CASE
             WHEN user_skill_subscriptions.source_kind = 'invite'
               THEN 'invite'
             ELSE 'bundle_invite'
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
        [subscriptionId, bundle.bundle.id],
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
    await client.query(
      `UPDATE skill_access_invites
       SET redeemed_count = redeemed_count + 1
       WHERE id = $1`,
      [invite.id],
    );
    await client.query('COMMIT');
    return {
      status: 'redeemed',
      targetType: 'bundle',
      subscribedCount,
      skippedCount,
      subscriptionIds,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
