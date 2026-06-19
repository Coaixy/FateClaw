import type { DatabaseMigration } from '../types.js';

/**
 * 数据库迁移分段:0053。
 *
 * 卦师使用权改为「纯使用权」(模型 A):把 clarity 的月度免费额度清零。
 * 卦师付的是网站使用权(66 积分/月),AI 用量走 BYOK 或平台余额,会员本身不再
 * 含每月免费 token 额度。存量旧档(insight/deep)已按"未用额度 × 实付"补贴过,
 * 补完统一为无免费额度的卦师使用权——故会员页不再展示"会员免费额度进度"。
 */
export const clarityNoAllowanceMigrations: readonly DatabaseMigration[] = [
  {
    id: '0053_clarity_no_free_allowance',
    description: '卦师使用权改为纯使用权:月度免费额度清零(AI 走 BYOK/余额)',
    async up(client) {
      await client.query(`
        UPDATE membership_config
        SET monthly_allowance_units = 0
        WHERE id = 'fateclaw_clarity'
      `);
    },
  },
];
