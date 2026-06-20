import type { DatabaseMigration } from '../types.js';
import { ensureCheckConstraint } from '../helpers.js';

/**
 * 数据库迁移分段：0056。
 *
 * 引荐奖励档位收敛到单层「卦师使用权」(clarity)。
 *
 * 0044 引入的 referral_config.reward_membership_plan_key 默认值是 'fateclaw_insight'
 * （已停售档），CHECK 仍允许三档（clarity/insight/deep）。单层化后若运营把引荐奖励
 * 配到 insight/deep，发放时 membership_config.enabled=false 会让 setUserMembership 报错、
 * 引荐奖励静默失败（事务回滚）。此迁移把默认值与存量行归一为 clarity，并收窄 CHECK
 * 为仅 clarity，从数据层杜绝"配到停售档"。
 *
 * 幂等：SET DEFAULT、UPDATE（仅命中非 clarity 行）、DROP IF EXISTS + 仅缺失时重建约束，
 * 重复执行均安全。
 */
export const referralRewardClarityMigrations: readonly DatabaseMigration[] = [
  {
    id: '0056_referral_reward_clarity_only',
    description:
      '引荐奖励档位收敛为单层卦师使用权(clarity)：默认值/存量/约束归一',
    async up(client) {
      // 默认值改为唯一在售档 clarity（替换 0044 的 'fateclaw_insight'）。
      await client.query(`
        ALTER TABLE referral_config
          ALTER COLUMN reward_membership_plan_key SET DEFAULT 'fateclaw_clarity'
      `);
      // 存量配置行：把任何非 clarity（含已停售 insight/deep）刷成 clarity。
      await client.query(`
        UPDATE referral_config
        SET reward_membership_plan_key = 'fateclaw_clarity'
        WHERE reward_membership_plan_key <> 'fateclaw_clarity'
      `);
      // 收窄 CHECK：先丢弃 0044 的三档约束，再重建为仅 clarity。
      await client.query(`
        ALTER TABLE referral_config
          DROP CONSTRAINT IF EXISTS chk_referral_config_reward_membership_plan_valid
      `);
      await ensureCheckConstraint(client, {
        constraintName: 'chk_referral_config_reward_membership_plan_valid',
        tableName: 'referral_config',
        expression: "reward_membership_plan_key = 'fateclaw_clarity'",
        cleanupSql: `UPDATE referral_config
                     SET reward_membership_plan_key = 'fateclaw_clarity'
                     WHERE reward_membership_plan_key <> 'fateclaw_clarity'`,
      });
    },
  },
];
