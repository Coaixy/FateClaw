import type { DatabaseMigration } from '../types.js';

/**
 * 数据库迁移分段：0059。
 *
 * 拆除会员免费额度(allowance)的库表残留。单层化后「卦师使用权」不含 AI 免费额度
 * (0053 已把 clarity 额度清零、0058 已删停售旧档配置行),代码侧 allowance 消费链
 * (ensure/consume/membership_allowances 读写)已全部移除,故在同一版本物理删除:
 *   - membership_allowances 整表(历史按期额度快照;老用户退款补贴已于单层化迁移时一次性结清,
 *     不再回看该表);
 *   - membership_config 的 monthly_allowance_units / standard_price_per_million_units_coins
 *     两列(依赖这两列的 CHECK 约束随 DROP COLUMN 自动移除)。
 *
 * forward-only、无 down。幂等:IF EXISTS 保证重复执行为空操作。
 * 前置:必须与"不再读写这些列/表"的代码一同上线(本分支已移除全部消费方);
 *   user_memberships.plan_key 对 membership_config 无外键、无表反向引用 membership_allowances,
 *   故 DROP 不触发外键违约。
 */
export const dropAllowanceColumnsAndTableMigrations: readonly DatabaseMigration[] =
  [
    {
      id: '0059_drop_allowance_columns_and_table',
      description:
        '拆除会员免费额度库表残留:DROP membership_allowances 表 + membership_config 两列',
      async up(client) {
        // 整表删除:其索引、UNIQUE、CHECK 约束随表一并移除。
        await client.query(`DROP TABLE IF EXISTS membership_allowances`);
        // 删两列:依赖这两列的 CHECK 约束(allowance/standard 非负等)随列自动移除。
        await client.query(
          `ALTER TABLE membership_config
             DROP COLUMN IF EXISTS monthly_allowance_units,
             DROP COLUMN IF EXISTS standard_price_per_million_units_coins`,
        );
      },
    },
  ];
