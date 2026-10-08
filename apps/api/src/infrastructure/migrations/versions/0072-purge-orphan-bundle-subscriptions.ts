import type pg from 'pg';

import type { DatabaseMigration } from '../types.js';
import { logger } from '../../logger.js';

/**
 * 一次性回收历史遗留的「孤儿 bundle 订阅」——即来源 bundle 已失效但订阅仍 active、继续授予权益的存量脏数据。
 *
 * @remarks
 * 修复上线前，只有「删除整个 bundle」会（且直到本次审计才会）回收订阅；而「取消分享 / 下架转私有 /
 * 从 bundle 移出 skill」这些同样让来源失效的操作都不回收，历史软删 bundle 也不清理残留来源行。
 * 结果是一批订阅记录的来源 bundle 早已失效，订阅却仍 active，在全量授权查询中持续授予本应收回的 skill。
 *
 * 本迁移与运行时 {@link purgeBundleSourceOrphanSubscriptionsUsing} 用同一套「有效来源」判定：来源 bundle
 * 必须存活（deleted_at IS NULL）、可分享（visibility IN link_shared/shared）且仍包含该 skill；先删掉所有
 * 不满足此条件的死来源行，再删除因此再无有效来源且无 direct source 的孤儿订阅，最后回退 skill 订阅计数。
 * removable 的 NOT EXISTS 用正向「仍有有效来源」判定，从而绕开「同一 WITH 内数据修改子句共享起始快照、
 * 看不到 dead_sources 删除效果」的坑（死来源即便仍在快照里也不满足有效条件）。
 *
 * 编号说明：接 0071（无效手机号用户清理）续号。
 */
export const purgeOrphanBundleSubscriptionsMigration: DatabaseMigration = {
  id: '0072_purge_orphan_bundle_subscriptions',
  description:
    '一次性回收历史失效 bundle（删除/取消分享/下架/移出 skill）遗留的孤儿订阅',
  up: async (client: pg.PoolClient): Promise<void> => {
    const { rows } = await client.query<{
      dead_source_count: number;
      purged_subscription_count: number;
    }>(
      `WITH dead_sources AS (
           DELETE FROM user_skill_subscription_bundle_sources src
           USING user_skill_subscriptions sub
           WHERE src.subscription_id = sub.id
             AND NOT EXISTS (
               SELECT 1
               FROM skill_bundles b
               JOIN skill_bundle_items sbi
                 ON sbi.bundle_id = b.id AND sbi.skill_id = sub.skill_id
               WHERE b.id = src.bundle_id
                 AND b.deleted_at IS NULL
                 AND b.visibility IN ('link_shared', 'shared')
             )
           RETURNING src.subscription_id
         ),
         removable AS (
           SELECT sub.id, sub.skill_id
           FROM user_skill_subscriptions sub
           JOIN (SELECT DISTINCT subscription_id FROM dead_sources) ds
             ON ds.subscription_id = sub.id
           WHERE sub.has_direct_source = false
             AND NOT EXISTS (
               SELECT 1
               FROM user_skill_subscription_bundle_sources other
               JOIN skill_bundles b ON b.id = other.bundle_id
               JOIN skill_bundle_items sbi
                 ON sbi.bundle_id = b.id AND sbi.skill_id = sub.skill_id
               WHERE other.subscription_id = sub.id
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
         SELECT
           (SELECT COUNT(*)::int FROM dead_sources) AS dead_source_count,
           (SELECT COUNT(*)::int FROM deleted_subscriptions) AS purged_subscription_count`,
    );
    const deadSourceCount = rows[0]?.dead_source_count ?? 0;
    const purgedSubscriptionCount = rows[0]?.purged_subscription_count ?? 0;
    if (deadSourceCount > 0 || purgedSubscriptionCount > 0) {
      logger.warn(
        { deadSourceCount, purgedSubscriptionCount },
        '一次性回收：清理历史失效 bundle 遗留的孤儿订阅与死来源行',
      );
    }
  },
};
