import { describe, expect, it } from 'vitest';

import { runDatabaseMigrations } from './migrations.js';

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
  it('creates the migration ledger and records unapplied migrations', async () => {
    const { client, calls } = createMockClient();

    await runDatabaseMigrations(client as never);

    expect(calls[0]?.sql).toBe('SELECT pg_advisory_lock($1, $2)');
    expect(calls[1]?.sql).toContain(
      'CREATE TABLE IF NOT EXISTS schema_migrations',
    );
    expect(
      calls.some((call) =>
        call.sql.includes('CREATE TABLE IF NOT EXISTS users'),
      ),
    ).toBe(true);
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0001_core_schema_baseline',
        '创建历史 init-pg.sql 承载的核心基础表',
      ],
    });
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0002_config_and_model_schema',
        '迁移系统密钥、模型配置与配置审计 schema',
      ],
    });
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0004_phone_only_user_schema',
        '迁移用户表到手机号唯一登录 schema',
      ],
    });
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0005_model_pi_api_schema',
        '迁移模型配置 provider 字段到 Pi API schema',
      ],
    });
    expect(
      calls.some((call) =>
        call.sql.includes('CREATE TABLE IF NOT EXISTS official_model_configs'),
      ),
    ).toBe(true);
    expect(
      calls.some((call) =>
        call.sql.includes('chk_official_model_configs_pi_api_valid'),
      ),
    ).toBe(true);
    expect(
      calls.some((call) =>
        call.sql.includes(
          'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_unique',
        ),
      ),
    ).toBe(true);
    expect(calls.some((call) => call.sql === 'BEGIN')).toBe(true);
    expect(calls.some((call) => call.sql === 'COMMIT')).toBe(true);
    expect(calls.at(-1)?.sql).toBe('SELECT pg_advisory_unlock($1, $2)');
  });

  it('skips migrations already recorded in the ledger', async () => {
    const { client, calls } = createMockClient([
      '0001_core_schema_baseline',
      '0002_config_and_model_schema',
      '0003_application_schema_expansion',
      '0004_phone_only_user_schema',
      '0005_model_pi_api_schema',
    ]);

    await runDatabaseMigrations(client as never);

    expect(
      calls.some((call) =>
        call.sql.includes('CREATE TABLE IF NOT EXISTS users'),
      ),
    ).toBe(false);
    expect(
      calls.some((call) => call.sql.includes('INSERT INTO schema_migrations')),
    ).toBe(false);
    expect(calls.some((call) => call.sql === 'BEGIN')).toBe(false);
    expect(calls.at(-1)?.sql).toBe('SELECT pg_advisory_unlock($1, $2)');
  });
});
