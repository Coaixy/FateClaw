import type { DatabaseMigration } from '../types.js';
import { ensureCheckConstraint } from '../helpers.js';

/**
 * 数据库迁移分段：0055。
 *
 * 修复 membership_allowances 额度约束与 membership_config 不一致的历史遗留。
 *
 * 单层化时 membership_config 的额度约束早已放宽为 monthly_allowance_units >= 0
 * （见 0042），以支持「卦师使用权」clarity 这类零免费额度套餐（0053 把 clarity
 * 月度额度清零）。但 membership_allowances（用户按周期的额度记录）表的孪生约束
 * 在部分环境仍停留在旧的 chk_membership_allowances_units_valid（allowance_units > 0）——
 * 0042 虽记录为已执行，其约束变更却未真正落到该库的实际 schema（迁移记录与 schema 漂移）。
 *
 * 后果：给「无当前周期额度行」的用户设 clarity 会员时，ensureMembershipAllowanceForUser
 * 需写入一行 allowance_units=0 的额度记录，撞上残留的 > 0 约束直接报错。
 *
 * 此迁移强制收敛：丢弃两种历史命名的旧约束（valid / nonnegative），统一重建为 >= 0，
 * 与 chk_membership_config_allowance_nonnegative 对齐。幂等：DROP IF EXISTS + 仅缺失时重建，
 * 与环境当前处于哪种约束状态无关。
 */
export const allowanceUnitsNonnegativeMigrations: readonly DatabaseMigration[] =
  [
    {
      id: '0055_allowance_units_nonnegative',
      description:
        '放宽 membership_allowances 额度约束为 >= 0，支持零额度的卦师使用权',
      async up(client) {
        // 丢弃两种历史命名的旧约束，确保无论该库当前是 valid(>0) 还是 nonnegative(>=0)，
        // 都收敛到统一的 >= 0 定义。
        await client.query(`
          ALTER TABLE membership_allowances
            DROP CONSTRAINT IF EXISTS chk_membership_allowances_units_valid
        `);
        await client.query(`
          ALTER TABLE membership_allowances
            DROP CONSTRAINT IF EXISTS chk_membership_allowances_units_nonnegative
        `);
        await ensureCheckConstraint(client, {
          constraintName: 'chk_membership_allowances_units_nonnegative',
          tableName: 'membership_allowances',
          expression: 'allowance_units >= 0 AND used_units >= 0',
          // 收敛历史脏数据：把任何负值夹回 0，以满足新约束。
          cleanupSql: `UPDATE membership_allowances
                       SET allowance_units = GREATEST(allowance_units, 0),
                           used_units = GREATEST(used_units, 0)
                       WHERE allowance_units < 0 OR used_units < 0`,
        });
      },
    },
  ];
