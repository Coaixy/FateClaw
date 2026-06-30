import { describe, expect, it } from 'vitest';

import { runDatabaseMigrations } from '../../src/infrastructure/migrations.js';

interface QueryCall {
  sql: string;
  params?: unknown[];
}

function createMockClient(appliedIds: string[] = []) {
  const calls: QueryCall[] = [];
  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (sql === 'SELECT id FROM schema_migrations') {
        return { rows: appliedIds.map((id) => ({ id })) };
      }
      return { rows: [] };
    },
  };

  return { client, calls };
}

describe('runDatabaseMigrations', () => {
  it('creates the migration ledger and applies the squashed baseline', async () => {
    const { client, calls } = createMockClient();

    await runDatabaseMigrations(client as never);

    // 加锁 → 建账本 → 查已应用
    expect(calls[0]?.sql).toBe('SELECT pg_advisory_lock($1, $2)');
    expect(calls[1]?.sql).toContain(
      'CREATE TABLE IF NOT EXISTS schema_migrations',
    );

    // 基线在单条事务内执行，整段 schema 通过一次 query 落库
    expect(calls.some((call) => call.sql === 'BEGIN')).toBe(true);
    expect(calls.some((call) => call.sql === 'COMMIT')).toBe(true);
    const baselineSql = calls.find((call) =>
      call.sql.includes('CREATE TABLE public.users'),
    )?.sql;
    expect(baselineSql).toBeDefined();
    // 抽样核对基线覆盖到关键表与默认配置种子
    expect(baselineSql).toContain('CREATE TABLE public.runtime_config');
    expect(baselineSql).toContain('CREATE TABLE public.membership_config');
    expect(baselineSql).toContain('CREATE TABLE public.announcements');
    expect(baselineSql).toContain('INSERT INTO public.runtime_config');

    // 基线以历史首条 id 记账，确保已存在的库会跳过
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0001_core_schema_baseline',
        '全量基线 schema（压平历史 0001-0067 迁移）',
      ],
    });

    expect(calls.at(-1)?.sql).toBe('SELECT pg_advisory_unlock($1, $2)');
  });

  it('skips migrations already recorded in the ledger', async () => {
    const { client, calls } = createMockClient([
      '0001_core_schema_baseline',
      '0070_agent_runtime_and_billing_perf',
    ]);

    await runDatabaseMigrations(client as never);

    expect(
      calls.some((call) => call.sql.includes('CREATE TABLE public.users')),
    ).toBe(false);
    expect(
      calls.some((call) => call.sql.includes('INSERT INTO schema_migrations')),
    ).toBe(false);
    expect(calls.some((call) => call.sql === 'BEGIN')).toBe(false);
    expect(calls.at(-1)?.sql).toBe('SELECT pg_advisory_unlock($1, $2)');
  });
});
