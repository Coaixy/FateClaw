/**
 * 回填脚本：为 bazi_cases 反推阳历生日(算大运用)。
 *
 * 命例只有四柱干支、无出生日期。本脚本在 1900-2026 内找一个四柱完全吻合的阳历日期填入
 * solar_date / solar_hour。反推年份不保证是真实出生年,但据此算出的大运起运岁数 + 干支序列
 * + 年龄区间准确可信(见迁移 0063 注释)。
 *
 * 运行：apps/api/node_modules/.bin/tsx apps/api/src/app/backfill-bazi-solar-dates.ts
 * 幂等：只处理 solar_date 为空的行,可反复运行补齐。
 */
import { getBaZi, type BaZiConfig, type Gender } from 'bazi-ts-lib';

import { DATABASE_URL } from '../infrastructure/config.js';
import {
  closeDbPool,
  getDbPool,
  initDbPool,
} from '../infrastructure/db-pool.js';
import { runDatabaseMigrations } from '../infrastructure/migrations.js';

const config: Partial<BaZiConfig> = {
  zishiMode: 'early',
  childLimitMode: 'default',
  decadeCount: 11,
};

/** 正算某阳历时刻的四柱干支。 */
function pillarsAt(y: number, m: number, d: number, h: number, gender: Gender) {
  const b = getBaZi(new Date(y, m - 1, d, h, 0, 0), gender, config);
  return {
    y: b.pillars.year.sixtyCycle,
    m: b.pillars.month.sixtyCycle,
    d: b.pillars.day.sixtyCycle,
    h: b.pillars.hour.sixtyCycle,
  };
}

/** 1900-2026 内年柱匹配的候选年(年中取样,避开立春边界)。 */
function candidateYears(targetYear: string, gender: Gender): number[] {
  const ys: number[] = [];
  for (let y = 1900; y <= 2026; y++) {
    if (pillarsAt(y, 6, 1, 12, gender).y === targetYear) ys.push(y);
  }
  return ys;
}

/** 反推：返回首个四柱完全吻合的阳历 {y,m,d,h}，无解返回 null。 */
function reverse(
  target: { y: string; m: string; d: string; h: string },
  gender: Gender,
): { y: number; m: number; d: number; h: number } | null {
  for (const cy of candidateYears(target.y, gender)) {
    // 年柱区间跨两个公历年(立春 cy → 立春 cy+1):年初(立春前)在 cy-1 末,
    // 年末月份(子/丑月)落在 cy+1 年 1 月,故 cy-1 / cy / cy+1 三年都扫。
    for (const yy of [cy - 1, cy, cy + 1]) {
      for (let m = 1; m <= 12; m++) {
        const daysInMonth = new Date(yy, m, 0).getDate();
        for (let d = 1; d <= daysInMonth; d++) {
          const noon = pillarsAt(yy, m, d, 12, gender);
          if (
            noon.y === target.y &&
            noon.m === target.m &&
            noon.d === target.d
          ) {
            // 定时辰：找时柱匹配且日柱仍匹配的小时(规避早晚子时跨日）
            for (let h = 0; h < 24; h++) {
              const p = pillarsAt(yy, m, d, h, gender);
              if (p.h === target.h && p.d === target.d) {
                return { y: yy, m, d, h };
              }
            }
          }
        }
      }
    }
  }
  return null;
}

async function main(): Promise<void> {
  if (!DATABASE_URL) throw new Error('缺少 DATABASE_URL 环境变量');

  initDbPool(DATABASE_URL);
  const client = await getDbPool().connect();
  try {
    await runDatabaseMigrations(client); // 确保 solar_date/solar_hour 列已存在

    const { rows } = await client.query<{
      id: number;
      bazi: string;
      gender: string;
    }>(
      'SELECT id, bazi, gender FROM bazi_cases WHERE solar_date IS NULL ORDER BY id',
    );
    console.log(`待回填 ${rows.length} 条`);

    let ok = 0;
    let fail = 0;
    const failedIds: number[] = [];
    const startedAt = Date.now();

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const [y, m, d, h] = row.bazi.trim().split(/\s+/);
      const found = reverse({ y, m, d, h }, row.gender as Gender);

      if (found) {
        const solarDate = `${found.y}-${String(found.m).padStart(2, '0')}-${String(found.d).padStart(2, '0')}`;
        await client.query(
          'UPDATE bazi_cases SET solar_date = $1, solar_hour = $2 WHERE id = $3',
          [solarDate, found.h, row.id],
        );
        ok += 1;
      } else {
        fail += 1;
        failedIds.push(row.id);
      }

      if ((i + 1) % 100 === 0 || i === rows.length - 1) {
        const sec = Math.round((Date.now() - startedAt) / 1000);
        console.log(
          `进度 ${i + 1}/${rows.length}  成功 ${ok}  失败 ${fail}  耗时 ${sec}s`,
        );
      }
    }

    console.log(`\n回填完成：成功 ${ok}，失败 ${fail}`);
    if (failedIds.length > 0) {
      console.log(`无解 id(前 30 个): ${failedIds.slice(0, 30).join(', ')}`);
    }
  } finally {
    client.release();
    await closeDbPool();
  }
}

main().catch((err) => {
  console.error('回填失败：', err);
  process.exit(1);
});
