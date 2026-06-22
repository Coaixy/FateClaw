import type { DatabaseMigration } from '../types.js';

/**
 * 数据库迁移分段:0068。
 *
 * 给 runtime_config 增加两列,让"单请求超时"和"每账号并发"可在后台调整。此前这两项是
 * agent-runtime 进程内写死的环境变量默认值——既不在后台,且因 daemon 由 API spawn、env 走
 * 白名单(agent-env.ts),连 .env 都传不进去,实际一直锁死在默认值(超时 30 分钟 / 并发 1)。
 * - agent_request_timeout_ms:单次 AI 请求最长处理毫秒数,超时强制中断会话,防 LLM 挂起卡死。
 * - agent_account_concurrency:单账号 agent-runtime 同时处理的请求数(=1 时一条挂死会堵住后续)。
 *
 * @remarks 用 IF NOT EXISTS 守卫保证幂等;NOT NULL DEFAULT 会给既有行回填默认值,旧行为不变。
 */
export const runtimeAgentTimeoutConcurrencyMigrations: readonly DatabaseMigration[] =
  [
    {
      id: '0068_runtime_agent_timeout_concurrency',
      description:
        'runtime_config 加 agent_request_timeout_ms + agent_account_concurrency',
      async up(client) {
        await client.query(`
          ALTER TABLE runtime_config
            ADD COLUMN IF NOT EXISTS agent_request_timeout_ms INTEGER NOT NULL DEFAULT 1800000
        `);
        await client.query(`
          ALTER TABLE runtime_config
            ADD COLUMN IF NOT EXISTS agent_account_concurrency INTEGER NOT NULL DEFAULT 1
        `);
      },
    },
  ];
