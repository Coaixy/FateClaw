import type { DatabaseMigration } from '../types.js';

/**
 * 数据库迁移分段：0063。
 *
 * 八字命例补「反推阳历生日」列：命例数据只有四柱干支、没有出生日期,而算大运的起运岁数需要
 * 真实生日到节气的天数。故由回填脚本在 1900-2026 内反推一个四柱吻合的阳历日期存入,
 * 供 getFortune 计算大运。solar_date 为空表示反推失败(无解)。
 *
 * 注意：反推的年份不保证是命主真实出生年,因此据此算出的大运「起运岁数 + 干支序列 + 年龄区间」
 * 准确可信,但「绝对公历年份」不可信(展示层只用年龄区间,不展示公历年份)。
 */
export const baziCasesSolarDateMigrations: readonly DatabaseMigration[] = [
  {
    id: '0063_bazi_cases_solar_date',
    description: '为八字命例增加反推阳历生日列(算大运用)',
    async up(client) {
      await client.query(
        `ALTER TABLE bazi_cases ADD COLUMN IF NOT EXISTS solar_date DATE`,
      );
      await client.query(
        `ALTER TABLE bazi_cases ADD COLUMN IF NOT EXISTS solar_hour INTEGER`,
      );
    },
  },
];
