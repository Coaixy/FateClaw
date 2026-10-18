import type pg from 'pg';

import type { DatabaseMigration } from '#infrastructure/migrations/types';

/**
 * 补登「agent 运行时超时/并发配置」与「账单/用量性能索引」。
 *
 * @remarks
 * 这批对象原本来自一条从未提交、仅打在远程库上的实验迁移（历史 0068/0069）。
 * squash 时已把它们从远程清理范围中剔除并保留，此处正式补成受框架管理的迁移，
 * 使全新部署也具备相同对象，远程与源码就此收敛。
 *
 * 全部使用 `IF NOT EXISTS` 守卫：远程库已存在这些对象 → 本迁移为 no-op 仅记账；
 * 全新空库 → 在基线之上真正建出。
 *
 * 编号说明：基线 {@link '0001-core-baseline.ts'} 已压平历史 0001-0067，远程 ledger 另有
 * 历史 0068/0069 记录，故新迁移从 0070 续号以避免与任何已发布编号冲突。
 */
export const agentRuntimeAndBillingPerfMigration: DatabaseMigration = {
  id: '0070_agent_runtime_and_billing_perf',
  description: '补登 agent 运行时超时/并发配置列与账单、用量性能索引',
  up: async (client: pg.PoolClient): Promise<void> => {
    // runtime_config：agent 常驻运行时的单次请求超时（默认 30 分钟）与单账号并发上限
    await client.query(`
        ALTER TABLE runtime_config
          ADD COLUMN IF NOT EXISTS agent_request_timeout_ms integer NOT NULL DEFAULT 1800000,
          ADD COLUMN IF NOT EXISTS agent_account_concurrency integer NOT NULL DEFAULT 1
      `);
    // 账单幂等：按 request_id 命中钱包流水的部分索引（仅索引非空 request_id）
    await client.query(`
        CREATE INDEX IF NOT EXISTS idx_wallet_transactions_request_id
          ON wallet_transactions (request_id)
          WHERE request_id IS NOT NULL
      `);
    // 每日用量按日期查询的索引
    await client.query(`
        CREATE INDEX IF NOT EXISTS idx_daily_usage_date
          ON daily_usage (date)
      `);
  },
};
