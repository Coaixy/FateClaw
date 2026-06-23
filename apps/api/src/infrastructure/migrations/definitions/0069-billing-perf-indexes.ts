import type { DatabaseMigration } from '../types.js';

/**
 * 数据库迁移分段:0069。
 *
 * 计费相关查询补两个缺失索引(审计 perf-3 / perf-5):
 * - daily_usage 仅有复合主键 (user_id, date),公开状态页/后台状态页按 date 聚合
 *   (WHERE date = ANY(...) / WHERE date = $1,不带 user_id)无法利用主键前缀,只能 Seq Scan;
 *   补 (date) 索引使按日聚合走索引。
 * - wallet_transactions 仅有 (user_id,created_at)/(created_at)/(kind,created_at) 索引,
 *   幂等重结算回看 metadata 的 `WHERE request_id = $1` 无法精准命中;补 request_id 部分索引。
 *
 * @remarks 全部 IF NOT EXISTS 守卫,幂等可重复执行;纯加索引,不改数据与既有行为。
 */
export const billingPerfIndexMigrations: readonly DatabaseMigration[] = [
  {
    id: '0069_billing_perf_indexes',
    description: 'daily_usage(date) 与 wallet_transactions(request_id) 补索引',
    async up(client) {
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_daily_usage_date
          ON daily_usage(date)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_wallet_transactions_request_id
          ON wallet_transactions(request_id)
          WHERE request_id IS NOT NULL
      `);
    },
  },
];
