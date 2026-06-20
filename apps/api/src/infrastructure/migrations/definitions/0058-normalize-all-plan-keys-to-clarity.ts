import type { DatabaseMigration } from '../types.js';

/**
 * 数据库迁移分段：0058。
 *
 * 全量归一:把 user_memberships 与 membership_config 里残留的非 clarity 旧档
 * (insight/deep/plus/pro,含 0054 未触及的 cancelled 历史行)物理收敛为单层
 * 「卦师使用权」(clarity)。这是代码侧彻底删除多档识别脚手架(LEGACY_MAP /
 * normalize 的 legacy 分支 / rank 排序梯子)的数据前置——归一后库内 plan_key 仅剩
 * clarity,识别逻辑才不再 load-bearing。
 *
 * 背景:0054 只归一了 status='active' 行;线上仍残留极少量 cancelled 旧档行,以及
 * membership_config 的停售旧档配置行(default/insight/deep/pro,enabled=false)。
 * 会员塌缩为单层后这些旧档不授予任何权益(权益只看 membership.active),老用户也已
 * 按"未用额度 × 实付"补贴过,故此处把档位字段一并归一。
 *
 * 主键 (user_id, plan_key) 处理:单用户可并存多条不同 plan_key 行(如 insight + deep,
 * 或旧档 + 已有 clarity),裸 UPDATE plan_key 会撞主键。故对"持有任一非 clarity 行"的
 * 用户,把其全部会员行合并重建为单条 clarity:
 *   - status:任一行 active 则 active,否则 cancelled;
 *   - 周期:有 active 行时只取 active 行的范围(MIN 起点 / MAX 到期),避免被 cancelled
 *     历史行的旧周期错误地延长有效期;无 active 行时取全部行范围。
 *   - created_at:保留最早(MIN),对用户最公平。
 * 该范围必然满足 CHECK(current_period_end > current_period_start)。
 *
 * membership_config:user_memberships.plan_key 对 membership_config.id 无外键,
 * membership_allowances 也无表引用,故可安全删除停售旧档配置行,只留在售 clarity。
 *
 * 幂等:仅命中"持有非 clarity 行"的用户;归一后无非 clarity 行,重复执行聚合集为空、
 * DELETE/INSERT 均空操作。每个迁移由 runner 包 BEGIN/COMMIT,步骤 4 自验失败整体回滚。
 */
export const normalizeAllPlanKeysToClarityMigrations: readonly DatabaseMigration[] =
  [
    {
      id: '0058_normalize_all_plan_keys_to_clarity',
      description:
        '全量归一残留旧档 plan_key 为 clarity(含 cancelled 行与 config 停售行)',
      async up(client) {
        // 步骤 1:聚合每个"持有非 clarity 行"用户的合并目标(临时表随事务提交自动清理)。
        await client.query(`
          CREATE TEMP TABLE _plan_key_normalize ON COMMIT DROP AS
          SELECT user_id,
                 bool_or(status = 'active') AS has_active,
                 MIN(current_period_start) FILTER (WHERE status = 'active') AS active_period_start,
                 MAX(current_period_end)   FILTER (WHERE status = 'active') AS active_period_end,
                 MIN(current_period_start) AS any_period_start,
                 MAX(current_period_end)   AS any_period_end,
                 MIN(created_at)           AS created_at
          FROM user_memberships
          WHERE user_id IN (
            SELECT user_id FROM user_memberships
            WHERE plan_key <> 'fateclaw_clarity'
          )
          GROUP BY user_id
        `);

        // 步骤 2:删除这些用户的全部会员行(含可能已存在的 clarity 行),避免步骤 3 INSERT 撞主键。
        await client.query(`
          DELETE FROM user_memberships
          WHERE user_id IN (SELECT user_id FROM _plan_key_normalize)
        `);

        // 步骤 3:为每个受影响用户重建单条 clarity 会员。
        await client.query(`
          INSERT INTO user_memberships (
            user_id, plan_key, status,
            current_period_start, current_period_end, created_at, updated_at
          )
          SELECT user_id, 'fateclaw_clarity',
                 CASE WHEN has_active THEN 'active' ELSE 'cancelled' END,
                 CASE WHEN has_active THEN active_period_start ELSE any_period_start END,
                 CASE WHEN has_active THEN active_period_end   ELSE any_period_end END,
                 created_at, NOW()
          FROM _plan_key_normalize
        `);

        // 步骤 4:删除 membership_config 里停售旧档配置行(无外键引用),只保留在售 clarity。
        await client.query(`
          DELETE FROM membership_config
          WHERE id <> 'fateclaw_clarity'
        `);

        // 步骤 5:自验——归一后 user_memberships 不应再有非 clarity 行,否则整体回滚。
        const { rows } = await client.query<{ plan_key: string }>(
          `SELECT DISTINCT plan_key
           FROM user_memberships
           WHERE plan_key <> 'fateclaw_clarity'`,
        );
        if (rows.length > 0) {
          throw new Error(
            `0058 归一失败:user_memberships 仍存在非 clarity plan_key: ${rows
              .map((row) => row.plan_key)
              .join(', ')}`,
          );
        }
      },
    },
  ];
