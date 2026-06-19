import type { DatabaseMigration } from '../types.js';

// 单层化前的全部相关在册套餐 key（含已停用旧档与当前在售的 clarity）。
const ALL_RELEVANT_PLAN_KEYS = `'fateclaw_clarity', 'fateclaw_insight', 'fateclaw_deep', 'fateclaw_plus', 'fateclaw_pro'`;
// 已停用的旧档 key：仍挂这些 key 的 active 会员就是本次要归一的对象。
const LEGACY_ACTIVE_PLAN_KEYS = `'fateclaw_insight', 'fateclaw_deep', 'fateclaw_plus', 'fateclaw_pro'`;

/**
 * 数据库迁移分段：0054。
 *
 * 存量会员数据层归一：把仍挂旧档（insight/deep/plus/pro）的 active 会员 plan_key
 * 刷成 clarity（卦师使用权）。会员已塌缩为单层，旧档不再授予任何额外权益（权益只看
 * membership.active），老用户也已按"未用额度 × 实付"补贴过——此处把 user_memberships
 * 的档位字段一并归一，使续费/展示/任何按 plan_key 的逻辑都统一为卦师使用权。
 *
 * 难点：user_memberships 主键是 (user_id, plan_key)。部分存量用户同时持有多条 active
 * 会员行（如旧档 insight + deep，或旧档 + 已有 clarity），裸 UPDATE plan_key 会撞主键。
 * 故对"持有 active 旧档"的用户，把其全部相关 active 行合并为单条 clarity：周期起点取
 * 最早（MIN）、到期取最晚（MAX）、创建时间保留最早（MIN），对用户最公平——已付的最长
 * 有效期都兑现，且必然满足 CHECK(current_period_end > current_period_start)。
 *
 * 幂等：仅命中"含 active 旧档"的用户；重复执行时旧档已清空，聚合集为空，DELETE/INSERT
 * 均为空操作。不动 cancelled 历史行与 membership_allowances 的按期额度快照。
 */
export const migrateLegacyMembersToClarityMigrations: readonly DatabaseMigration[] =
  [
    {
      id: '0054_migrate_legacy_active_members_to_clarity',
      description: '存量 active 旧档会员 plan_key 归一为 clarity（卦师使用权）',
      async up(client) {
        // 步骤 1：聚合每个"持有 active 旧档"用户的合并目标周期。
        //         临时表随事务提交自动清理（runner 对每个迁移包 BEGIN/COMMIT）。
        await client.query(`
          CREATE TEMP TABLE _legacy_member_merge ON COMMIT DROP AS
          SELECT user_id,
                 MIN(current_period_start) AS current_period_start,
                 MAX(current_period_end)   AS current_period_end,
                 MIN(created_at)           AS created_at
          FROM user_memberships
          WHERE status = 'active'
            AND plan_key IN (${ALL_RELEVANT_PLAN_KEYS})
            AND user_id IN (
              SELECT user_id
              FROM user_memberships
              WHERE status = 'active'
                AND plan_key IN (${LEGACY_ACTIVE_PLAN_KEYS})
            )
          GROUP BY user_id
        `);

        // 步骤 2：删除这些用户的全部相关 active 行（含可能已存在的 clarity 行），
        //         避免步骤 3 INSERT 时撞 (user_id, plan_key) 主键。
        await client.query(`
          DELETE FROM user_memberships
          WHERE status = 'active'
            AND plan_key IN (${ALL_RELEVANT_PLAN_KEYS})
            AND user_id IN (SELECT user_id FROM _legacy_member_merge)
        `);

        // 步骤 3：为每个受影响用户重建单条 clarity 会员，沿用合并后的最早起点 / 最晚到期 / 最早创建时间。
        // ON CONFLICT 兜底：主键是 (user_id, plan_key) 不含 status，若该用户早先退订残留一条
        // cancelled 的 clarity 行（步骤 2 只删 active、不动历史），裸 INSERT 会撞主键——此时改为
        // 复活并更新那行为合并后的 active clarity，语义正确且不丢其原始 created_at。
        await client.query(`
          INSERT INTO user_memberships (
            user_id, plan_key, status,
            current_period_start, current_period_end, created_at, updated_at
          )
          SELECT user_id, 'fateclaw_clarity', 'active',
                 current_period_start, current_period_end, created_at, NOW()
          FROM _legacy_member_merge
          ON CONFLICT (user_id, plan_key) DO UPDATE SET
            status = 'active',
            current_period_start = EXCLUDED.current_period_start,
            current_period_end = EXCLUDED.current_period_end,
            updated_at = NOW()
        `);
      },
    },
  ];
