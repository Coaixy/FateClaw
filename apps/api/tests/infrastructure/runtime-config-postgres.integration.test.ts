import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  pool: null as pg.Pool | null,
  del: vi.fn(),
}));
vi.mock('#infrastructure/db-pool', () => ({ getDbPool: () => state.pool }));
vi.mock('#infrastructure/redis', () => ({
  getRedis: () => ({ del: state.del }),
}));
import { MIGRATIONS } from '#infrastructure/migrations/manifest';
import {
  getRuntimeConfig,
  saveRuntimeConfig,
} from '#infrastructure/repositories/runtime-config-repository';
import { runRuntimeUpgrades } from '#runtime/runtime-upgrades';

const connectionString = process.env.FATECLAW_TEST_RUNTIME_CONFIG_DATABASE_URL;
describe.skipIf(!connectionString)('runtime policy durability', () => {
  let admin: pg.Pool;
  let databaseName: string;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString });
    databaseName = `fateclaw_runtime_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(connectionString!);
    url.pathname = `/${databaseName}`;
    state.pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
    const client = await state.pool.connect();
    try {
      for (const migration of MIGRATIONS) {
        if (migration.id === '0098_runtime_config') {
          await client.query(
            "UPDATE runtime_config SET agent_concurrency_limit=3,local_agent_max_processes=2,local_agent_idle_ttl_ms=120000 WHERE id='default'",
          );
        }
        await migration.up(client);
      }
    } finally {
      client.release();
    }
  }, 30_000);
  afterAll(async () => {
    await state.pool?.end();
    if (databaseName) await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin?.end();
  });

  it('preserves existing admin limits and defaults WeChat access to disabled', async () => {
    expect(await getRuntimeConfig()).toMatchObject({
      agent_concurrency_limit: 3,
      local_agent_max_processes: 2,
      local_agent_idle_ttl_ms: 120_000,
      wechat_claw_enabled: false,
      revision: 1,
    });
  });

  it('commits only one concurrent revision and records its audit atomically', async () => {
    const { updated_at: _time, ...config } = await getRuntimeConfig();
    const results = await Promise.allSettled([
      saveRuntimeConfig({ ...config, agent_concurrency_limit: 4 }, 'owner-a'),
      saveRuntimeConfig({ ...config, agent_concurrency_limit: 5 }, 'owner-b'),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const failure = results.find(
      (result) => result.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(failure.reason).toMatchObject({ statusCode: 409 });
    expect((await getRuntimeConfig()).revision).toBe(2);
    expect(
      (
        await state.pool!.query(
          "SELECT count(*)::int AS count FROM config_audit_logs WHERE target_type='runtime_config'",
        )
      ).rows[0].count,
    ).toBe(1);
  });

  it('rolls the policy update back when its required audit cannot persist', async () => {
    const before = await getRuntimeConfig();
    await state.pool!
      .query(`CREATE FUNCTION reject_runtime_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$;
      CREATE TRIGGER runtime_audit_failure BEFORE INSERT ON config_audit_logs FOR EACH ROW EXECUTE FUNCTION reject_runtime_audit()`);
    try {
      const { updated_at: _time, ...config } = before;
      await expect(
        saveRuntimeConfig({ ...config, agent_concurrency_limit: 6 }, 'owner'),
      ).rejects.toThrow('synthetic audit failure');
      expect(await getRuntimeConfig()).toEqual(before);
    } finally {
      await state.pool!.query(
        'DROP TRIGGER runtime_audit_failure ON config_audit_logs; DROP FUNCTION reject_runtime_audit()',
      );
    }
  });

  it('retries cross-store upgrade work after failure and skips completed work', async () => {
    state.del.mockRejectedValueOnce(new Error('synthetic Redis outage'));
    await expect(runRuntimeUpgrades()).rejects.toThrow(
      'synthetic Redis outage',
    );
    expect(
      (
        await state.pool!.query(
          'SELECT completed_at FROM runtime_upgrade_tasks',
        )
      ).rows[0].completed_at,
    ).toBeNull();
    state.del.mockResolvedValue(0);
    await runRuntimeUpgrades();
    await runRuntimeUpgrades();
    expect(state.del).toHaveBeenCalledTimes(2);
    expect(
      (
        await state.pool!.query(
          'SELECT completed_at FROM runtime_upgrade_tasks',
        )
      ).rows[0].completed_at,
    ).not.toBeNull();
  });
});
