/**
 * 一次性导入脚本：把 backups/elidli_cases.jsonl 的八字命例写入 bazi_cases 表。
 *
 * 运行：pnpm --dir ../.. exec tsx apps/api/src/app/import-bazi-cases.ts [可选 jsonl 路径]
 * 幂等：以源数据自带 id 为主键，ON CONFLICT(id) DO UPDATE 覆盖全部列，可反复运行。
 * 独立可跑：脚本内部会先执行迁移确保表存在，无需先启动 API。
 */
import fs from 'node:fs';
import path from 'node:path';

import { DATABASE_URL } from '../infrastructure/config.js';
import {
  closeDbPool,
  getDbPool,
  initDbPool,
} from '../infrastructure/db-pool.js';
import { runDatabaseMigrations } from '../infrastructure/migrations.js';
import { resolveProjectRoot } from '../infrastructure/project-root.js';

/** 源数据 jsonl 单行结构（camelCase，与文件原样一致）。 */
interface RawCase {
  id: number;
  baZi: string;
  gender: string;
  marriage?: string;
  childrenDesc?: string;
  abortionsSize?: number;
  childDeathsSize?: number;
  currentEducation?: string;
  currentParent?: string;
  initWealth?: string;
  currentWealth?: string;
  job?: string;
  jobType?: string;
  jobInfo?: string;
}

/** -1 是源数据里的「缺失」标记，统一归一为 null。 */
function normalizeSize(value: number | undefined): number | null {
  if (value === undefined || value === null || value === -1) return null;
  return value;
}

async function main(): Promise<void> {
  if (!DATABASE_URL) {
    throw new Error('缺少 DATABASE_URL 环境变量');
  }

  const dataPath =
    process.argv[2] ??
    path.join(resolveProjectRoot(), 'backups', 'elidli_cases.jsonl');

  const rows: RawCase[] = fs
    .readFileSync(dataPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RawCase);

  console.log(`读取到 ${rows.length} 条命例：${dataPath}`);

  initDbPool(DATABASE_URL);
  const client = await getDbPool().connect();
  try {
    // 确保 bazi_cases 表已建好（独立运行时无需先启动 API）
    await runDatabaseMigrations(client);

    await client.query('BEGIN');
    for (const row of rows) {
      await client.query(
        `INSERT INTO bazi_cases (
           id, bazi, gender, marriage, children_desc,
           abortions_size, child_deaths_size, current_education, current_parent,
           init_wealth, current_wealth, job, job_type, job_info
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (id) DO UPDATE SET
           bazi = EXCLUDED.bazi,
           gender = EXCLUDED.gender,
           marriage = EXCLUDED.marriage,
           children_desc = EXCLUDED.children_desc,
           abortions_size = EXCLUDED.abortions_size,
           child_deaths_size = EXCLUDED.child_deaths_size,
           current_education = EXCLUDED.current_education,
           current_parent = EXCLUDED.current_parent,
           init_wealth = EXCLUDED.init_wealth,
           current_wealth = EXCLUDED.current_wealth,
           job = EXCLUDED.job,
           job_type = EXCLUDED.job_type,
           job_info = EXCLUDED.job_info`,
        [
          row.id,
          row.baZi,
          row.gender,
          row.marriage ?? null,
          row.childrenDesc ?? null,
          normalizeSize(row.abortionsSize),
          normalizeSize(row.childDeathsSize),
          row.currentEducation ?? null,
          row.currentParent ?? null,
          row.initWealth ?? null,
          row.currentWealth ?? null,
          row.job ?? null,
          row.jobType ?? null,
          row.jobInfo ?? null,
        ],
      );
    }
    await client.query('COMMIT');

    const { rows: countRows } = await client.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM bazi_cases',
    );
    console.log(`导入完成，bazi_cases 现有 ${countRows[0]?.n ?? 0} 条`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await closeDbPool();
  }
}

main().catch((err) => {
  console.error('导入失败：', err);
  process.exit(1);
});
