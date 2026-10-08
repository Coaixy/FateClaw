import { describe, expect, it } from 'vitest';

import {
  BASELINES,
  MIGRATIONS,
  validateMigrationManifest,
} from '../../src/infrastructure/migrations/manifest.js';
import { runDatabaseMigrations } from '../../src/infrastructure/migrations/runner.js';
import type { DatabaseMigration } from '../../src/infrastructure/migrations/types.js';

interface QueryCall {
  sql: string;
  params?: unknown[];
}

function createMockClient(appliedIds: string[] = [], hasSchemaObjects = false) {
  const calls: QueryCall[] = [];
  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (sql === 'SELECT id FROM schema_migrations') {
        return { rows: appliedIds.map((id) => ({ id })) };
      }
      if (sql.includes('AS has_schema_objects')) {
        return { rows: [{ has_schema_objects: hasSchemaObjects }] };
      }
      return { rows: [] };
    },
  };

  return { client, calls };
}

describe('runDatabaseMigrations', () => {
  it('initializes an empty database from the snapshot and applies subsequent migrations', async () => {
    const { client, calls } = createMockClient();

    await runDatabaseMigrations(client as never);

    // Startup remains serialized before inspecting or changing the schema.
    expect(calls[0]?.sql).toBe('SELECT pg_advisory_lock($1, $2)');
    expect(calls[1]?.sql).toContain(
      'CREATE TABLE IF NOT EXISTS schema_migrations',
    );

    // The snapshot and all covered migration IDs share one transaction.
    expect(calls.some((call) => call.sql === 'BEGIN')).toBe(true);
    expect(calls.some((call) => call.sql === 'COMMIT')).toBe(true);
    const baselineSql = calls.find((call) =>
      call.sql.includes('CREATE TABLE public.users'),
    )?.sql;
    expect(baselineSql).toBeDefined();
    expect(baselineSql?.includes('CREATE TABLE public.runtime_config')).toBe(
      true,
    );
    expect(baselineSql?.includes('CREATE TABLE public.membership_config')).toBe(
      true,
    );
    expect(baselineSql?.includes('CREATE TABLE public.announcements')).toBe(
      true,
    );
    expect(
      calls.some(
        (call) => call.sql === 'DROP TABLE IF EXISTS public.announcements',
      ),
    ).toBe(true);
    expect(baselineSql?.includes('INSERT INTO public.runtime_config')).toBe(
      true,
    );
    expect(baselineSql?.includes('CREATE TABLE public.bazi_cases')).toBe(false);
    expect(baselineSql?.includes('CREATE TABLE public.agent_requests')).toBe(
      true,
    );
    const baselineMigrationCount =
      MIGRATIONS.findIndex(
        (migration) => migration.id === BASELINES.at(-1)?.throughMigrationId,
      ) + 1;
    const expectedTransactions = 1 + MIGRATIONS.length - baselineMigrationCount;
    expect(calls.filter((call) => call.sql === 'BEGIN')).toHaveLength(
      expectedTransactions,
    );
    expect(calls.filter((call) => call.sql === 'COMMIT')).toHaveLength(
      expectedTransactions,
    );
    expect(calls.some((call) => call.sql.includes('CREATE TEMP TABLE'))).toBe(
      false,
    );

    // Existing IDs keep new databases compatible with the same upgrade ledger.
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0001_core_schema_baseline',
        '全量基线 schema（压平历史 0001-0067 迁移）',
      ],
    });
    expect(
      calls
        .filter((call) => call.sql.includes('INSERT INTO schema_migrations'))
        .map((call) => call.params?.[0]),
    ).toEqual(MIGRATIONS.map((migration) => migration.id));

    expect(calls.at(-1)?.sql).toBe('SELECT pg_advisory_unlock($1, $2)');
  });

  it('rejects a nonempty schema with no migration history before applying SQL', async () => {
    const { client, calls } = createMockClient([], true);

    await expect(runDatabaseMigrations(client as never)).rejects.toThrow(
      'no migration history',
    );

    expect(calls.some((call) => call.sql === 'BEGIN')).toBe(false);
    expect(calls.at(-1)?.sql).toBe('SELECT pg_advisory_unlock($1, $2)');
  });

  it('rolls back the whole bootstrap when recording a covered migration fails', async () => {
    const { client, calls } = createMockClient();
    const query = client.query.bind(client);
    const error = new Error('synthetic ledger failure');
    client.query = async (sql, params) => {
      const result = await query(sql, params);
      if (params?.[0] === '0071_cleanup_invalid_phone_users') throw error;
      return result;
    };

    await expect(runDatabaseMigrations(client as never)).rejects.toBe(error);

    expect(calls.some((call) => call.sql === 'COMMIT')).toBe(false);
    expect(calls.some((call) => call.sql === 'ROLLBACK')).toBe(true);
    expect(calls.at(-1)?.sql).toBe('SELECT pg_advisory_unlock($1, $2)');
  });

  it('upgrades a database recorded through 0075 using only the missing migrations', async () => {
    const { client, calls } = createMockClient(
      MIGRATIONS.filter(
        (migration) => migration.id <= '0075_add_redemption_codes',
      ).map((migration) => migration.id),
    );

    await runDatabaseMigrations(client as never);

    expect(calls.filter((call) => call.sql === 'BEGIN')).toHaveLength(4);
    expect(
      calls.some((call) => call.sql.includes('CREATE TABLE public.users')),
    ).toBe(false);
    expect(
      calls
        .filter((call) => call.sql.includes('INSERT INTO schema_migrations'))
        .map((call) => call.params?.[0]),
    ).toEqual([
      '0076_durable_agent_requests',
      '0077_drop_bazi_cases',
      '0078_drop_public_financial_ledger',
      '0079_drop_announcements',
    ]);
  });

  it('skips migrations already recorded in the ledger', async () => {
    const { client, calls } = createMockClient(
      MIGRATIONS.map((migration) => migration.id),
    );

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

  it('applies migrations appended after the newest baseline as separate upgrades', async () => {
    const migrations = MIGRATIONS as DatabaseMigration[];
    migrations.push({
      id: '0080_synthetic_upgrade',
      description: 'Synthetic upgrade after the snapshot',
      async up(client) {
        await client.query('CREATE TABLE synthetic_upgrade (id INTEGER)');
      },
    });
    try {
      const { client, calls } = createMockClient();
      await runDatabaseMigrations(client as never);

      const baselineMigrationCount =
        migrations.findIndex(
          (migration) => migration.id === BASELINES.at(-1)?.throughMigrationId,
        ) + 1;
      const expectedTransactions =
        1 + migrations.length - baselineMigrationCount;
      expect(calls.filter((call) => call.sql === 'BEGIN')).toHaveLength(
        expectedTransactions,
      );
      expect(calls.filter((call) => call.sql === 'COMMIT')).toHaveLength(
        expectedTransactions,
      );
      const firstCommit = calls.findIndex((call) => call.sql === 'COMMIT');
      const upgrade = calls.findIndex(
        (call) => call.sql === 'CREATE TABLE synthetic_upgrade (id INTEGER)',
      );
      expect(upgrade).toBeGreaterThan(firstCommit);
      expect(
        calls
          .filter((call) => call.sql.includes('INSERT INTO schema_migrations'))
          .map((call) => call.params?.[0]),
      ).toEqual(migrations.map((migration) => migration.id));
    } finally {
      migrations.pop();
    }
  });

  it('drops the retired case dataset in a recorded transaction on existing databases', async () => {
    const { client, calls } = createMockClient(
      MIGRATIONS.filter(
        (migration) => migration.id !== '0077_drop_bazi_cases',
      ).map((migration) => migration.id),
    );

    await runDatabaseMigrations(client as never);

    const beginIndex = calls.findIndex((call) => call.sql === 'BEGIN');
    const dropIndex = calls.findIndex(
      (call) => call.sql === 'DROP TABLE IF EXISTS public.bazi_cases',
    );
    const ledgerIndex = calls.findIndex(
      (call) => call.params?.[0] === '0077_drop_bazi_cases',
    );
    const commitIndex = calls.findIndex((call) => call.sql === 'COMMIT');

    expect(dropIndex).toBeGreaterThanOrEqual(0);
    expect(beginIndex).toBeLessThan(dropIndex);
    expect(dropIndex).toBeLessThan(ledgerIndex);
    expect(ledgerIndex).toBeLessThan(commitIndex);
  });

  it('drops the retired public financial ledger in a recorded transaction on existing databases', async () => {
    const { client, calls } = createMockClient(
      MIGRATIONS.filter(
        (migration) => migration.id !== '0078_drop_public_financial_ledger',
      ).map((migration) => migration.id),
    );

    await runDatabaseMigrations(client as never);

    const beginIndex = calls.findIndex((call) => call.sql === 'BEGIN');
    const dropIndex = calls.findIndex(
      (call) =>
        call.sql ===
        'DROP TABLE IF EXISTS public.public_financial_ledger_entries',
    );
    const ledgerIndex = calls.findIndex(
      (call) => call.params?.[0] === '0078_drop_public_financial_ledger',
    );
    const commitIndex = calls.findIndex((call) => call.sql === 'COMMIT');

    expect(dropIndex).toBeGreaterThanOrEqual(0);
    expect(beginIndex).toBeLessThan(dropIndex);
    expect(dropIndex).toBeLessThan(ledgerIndex);
    expect(ledgerIndex).toBeLessThan(commitIndex);
  });

  it('drops retired announcements in a recorded transaction on existing databases', async () => {
    const { client, calls } = createMockClient(
      MIGRATIONS.filter(
        (migration) => migration.id !== '0079_drop_announcements',
      ).map((migration) => migration.id),
    );

    await runDatabaseMigrations(client as never);

    const beginIndex = calls.findIndex((call) => call.sql === 'BEGIN');
    const dropIndex = calls.findIndex(
      (call) => call.sql === 'DROP TABLE IF EXISTS public.announcements',
    );
    const ledgerIndex = calls.findIndex(
      (call) => call.params?.[0] === '0079_drop_announcements',
    );
    const commitIndex = calls.findIndex((call) => call.sql === 'COMMIT');

    expect(dropIndex).toBeGreaterThanOrEqual(0);
    expect(beginIndex).toBeLessThan(dropIndex);
    expect(dropIndex).toBeLessThan(ledgerIndex);
    expect(ledgerIndex).toBeLessThan(commitIndex);
  });

  it('runs the invalid-phone cleanup once as migration 0071 when unrecorded', async () => {
    // 回归防护：无效手机号用户清理已从「每次启动无条件跑」改为受账本管理的一次性迁移。
    // 未记录 0071 时应执行清理（建删除集临时表）并以 0071 记账；已记录则被上一个用例覆盖。
    const { client, calls } = createMockClient([
      '0001_core_schema_baseline',
      '0070_agent_runtime_and_billing_perf',
    ]);

    await runDatabaseMigrations(client as never);

    expect(
      calls.some((call) =>
        call.sql.includes('CREATE TEMP TABLE users_without_valid_phone'),
      ),
    ).toBe(true);
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0071_cleanup_invalid_phone_users',
        '一次性清理无有效手机号的历史脏用户及其关联数据',
      ],
    });
  });

  it('drops dead feature tables once as migration 0073 when unrecorded', async () => {
    // 回归防护：simpleWorkflow 预置表与 ai_chat 免费/专业额度三表已无任何代码接线，
    // 由一次性迁移 0073 在存量库上 DROP（全新库基线已不再建出这些表，届时为 no-op）。
    const { client, calls } = createMockClient([
      '0001_core_schema_baseline',
      '0070_agent_runtime_and_billing_perf',
      '0071_cleanup_invalid_phone_users',
      '0072_purge_orphan_bundle_subscriptions',
    ]);

    await runDatabaseMigrations(client as never);

    for (const table of [
      'simple_workflow_presets',
      'ai_chat_free_daily_usage',
      'ai_chat_free_quota_config',
      'ai_chat_professional_daily_usage',
    ]) {
      expect(
        calls.some(
          (call) => call.sql === `DROP TABLE IF EXISTS public.${table}`,
        ),
      ).toBe(true);
    }
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0073_drop_dead_feature_tables',
        '删除死功能表：simple_workflow_presets 与 ai_chat 免费/专业额度三表',
      ],
    });
  });

  it('drops removed feature tables once as migration 0074 when unrecorded', async () => {
    // 回归防护：礼品码/邀请返利/每日签到/技能点赞四组功能已删除，其残留的 9 张表
    // 由一次性迁移 0074 在存量库上按外键依赖顺序 DROP（全新库基线已不再建出这些表）。
    const { client, calls } = createMockClient([
      '0001_core_schema_baseline',
      '0070_agent_runtime_and_billing_perf',
      '0071_cleanup_invalid_phone_users',
      '0072_purge_orphan_bundle_subscriptions',
      '0073_drop_dead_feature_tables',
    ]);

    await runDatabaseMigrations(client as never);

    const dropOrder = [
      'gift_code_redemptions',
      'gift_codes',
      'referral_reward_events',
      'user_referrals',
      'user_invite_codes',
      'referral_config',
      'daily_sign_in_records',
      'daily_sign_in_config',
      'skill_reactions',
    ];
    // 逐表确认 DROP 语句存在，且子表先于其父表执行（外键依赖顺序）
    const dropIndexes = dropOrder.map((table) =>
      calls.findIndex(
        (call) => call.sql === `DROP TABLE IF EXISTS public.${table}`,
      ),
    );
    for (const index of dropIndexes) {
      expect(index).toBeGreaterThanOrEqual(0);
    }
    expect(dropIndexes).toEqual([...dropIndexes].sort((a, b) => a - b));
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0074_drop_removed_feature_tables',
        '删除已删功能残留表：礼品码/邀请返利/每日签到/技能点赞 共 9 张',
      ],
    });
  });

  it('purges orphan bundle subscriptions once as migration 0072 when unrecorded', async () => {
    // 回归防护：历史失效 bundle（删除/取消分享/下架/移出 skill）遗留的孤儿订阅回收，
    // 作为一次性迁移 0072 执行（删死来源行）并以 0072 记账。
    const { client, calls } = createMockClient([
      '0001_core_schema_baseline',
      '0070_agent_runtime_and_billing_perf',
      '0071_cleanup_invalid_phone_users',
    ]);

    await runDatabaseMigrations(client as never);

    expect(
      calls.some((call) =>
        call.sql.includes('DELETE FROM user_skill_subscription_bundle_sources'),
      ),
    ).toBe(true);
    expect(calls).toContainEqual({
      sql: expect.stringContaining('INSERT INTO schema_migrations'),
      params: [
        '0072_purge_orphan_bundle_subscriptions',
        '一次性回收历史失效 bundle（删除/取消分享/下架/移出 skill）遗留的孤儿订阅',
      ],
    });
  });
});

describe('migration manifest', () => {
  it('validates the registered upgrade and baseline boundaries', () => {
    expect(() =>
      validateMigrationManifest(MIGRATIONS, BASELINES),
    ).not.toThrow();
  });

  it('rejects duplicate IDs rather than allowing different operations to share a ledger entry', () => {
    expect(() =>
      validateMigrationManifest([...MIGRATIONS, MIGRATIONS[0]], BASELINES),
    ).toThrow('Duplicate database migration ID');
  });

  it('rejects reordered migration IDs', () => {
    expect(() =>
      validateMigrationManifest([...MIGRATIONS].reverse(), BASELINES),
    ).toThrow('increasing ID order');
  });

  it('rejects a baseline that claims an unknown upgrade boundary', () => {
    expect(() =>
      validateMigrationManifest(MIGRATIONS, [
        { ...BASELINES[0], throughMigrationId: '9999_unknown' },
      ]),
    ).toThrow('Unknown baseline migration boundary');
  });

  it('requires a registered baseline', () => {
    expect(() => validateMigrationManifest(MIGRATIONS, [])).toThrow(
      'No database baseline registered',
    );
  });

  it('rejects duplicate or reordered baseline boundaries', () => {
    expect(() =>
      validateMigrationManifest(MIGRATIONS, [...BASELINES, BASELINES[0]]),
    ).toThrow('increasing migration boundaries');
  });
});
