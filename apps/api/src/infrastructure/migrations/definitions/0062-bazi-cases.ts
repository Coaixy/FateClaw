import type { DatabaseMigration } from '../types.js';

/**
 * 数据库迁移分段：0062。
 *
 * 八字命例数据集：一份「八字 → 真实人生结果」的标注语料（出身/学历/婚姻/子女/财富起止/职业轨迹），
 * 作为公开可浏览的命例展览与开放查询 API 的数据底座。字段 1:1 映射源数据 jsonl，
 * 主键直接复用源数据自带的整型 id（已验证全表唯一）。
 *
 * 这是只读参考数据，不归属任何用户、无软删除；导入由独立脚本 import-bazi-cases.ts 完成。
 */
export const baziCasesMigrations: readonly DatabaseMigration[] = [
  {
    id: '0062_bazi_cases',
    description: '增加八字命例数据集表（公开展览 + 开放查询）',
    async up(client) {
      // 命例数据集：children_desc 原样存字符串（源数据有「1女1儿」「3女1男」等不规整写法，硬拆成男/女计数得不偿失）。
      // abortions_size / child_deaths_size 为可空整数，源数据中的 -1（缺失标记）在导入时归一为 NULL。
      await client.query(`
        CREATE TABLE IF NOT EXISTS bazi_cases (
          id                INTEGER PRIMARY KEY,
          bazi              TEXT NOT NULL,
          gender            TEXT NOT NULL,
          marriage          TEXT,
          children_desc     TEXT,
          abortions_size    INTEGER,
          child_deaths_size INTEGER,
          current_education TEXT,
          current_parent    TEXT,
          init_wealth       TEXT,
          current_wealth    TEXT,
          job               TEXT,
          job_type          TEXT,
          job_info          TEXT
        )
      `);
      // 列表按这些维度筛选，建单列索引（当前数据量小其实可全表扫，索引为后续数据增长留出余量）。
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_bazi_cases_gender ON bazi_cases(gender)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_bazi_cases_marriage ON bazi_cases(marriage)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_bazi_cases_current_wealth ON bazi_cases(current_wealth)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_bazi_cases_current_education ON bazi_cases(current_education)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_bazi_cases_job_type ON bazi_cases(job_type)`,
      );
    },
  },
];
