import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
const state = vi.hoisted(() => ({ pool: null as pg.Pool | null }));
vi.mock('../../src/infrastructure/db-pool.js', () => ({
  getDbPool: () => state.pool,
}));
import { MIGRATIONS } from '../../src/infrastructure/migrations/manifest.js';
import {
  claimServiceStatusCheck,
  completeServiceStatusCheck,
  listServiceStatusChecks,
} from '../../src/infrastructure/repositories/service-status-repository.js';

// This must be an explicitly supplied disposable server, never the application's DATABASE_URL.
const connectionString = process.env.FATECLAW_TEST_SERVICE_STATUS_DATABASE_URL;
describe.skipIf(!connectionString)(
  'shared service status PostgreSQL integration',
  () => {
    let admin: pg.Pool;
    let name: string;
    beforeAll(async () => {
      admin = new pg.Pool({ connectionString });
      name = `fateclaw_status_${randomUUID().replaceAll('-', '')}`;
      await admin.query(`CREATE DATABASE "${name}"`);
      const url = new URL(connectionString!);
      url.pathname = `/${name}`;
      state.pool = new pg.Pool({ connectionString: url.toString(), max: 8 });
      const client = await state.pool.connect();
      try {
        for (const migration of MIGRATIONS) await migration.up(client);
      } finally {
        client.release();
      }
    });
    beforeEach(async () => {
      await state.pool!.query(
        'TRUNCATE ai_service_status_checks,ai_service_status_schedule',
      );
      await state.pool!.query(
        "INSERT INTO ai_service_status_schedule (id) VALUES ('ai')",
      );
    });
    afterAll(async () => {
      await state.pool?.end();
      if (name) await admin.query(`DROP DATABASE "${name}"`);
      await admin?.end();
    });
    it('allows one global check and keeps its six-hour budget after completion and restart', async () => {
      const claims = await Promise.all(
        Array.from({ length: 8 }, () => claimServiceStatusCheck()),
      );
      const token = claims.find(Boolean)!;
      expect(claims.filter(Boolean)).toHaveLength(1);
      await completeServiceStatusCheck(token, {
        checked_at: new Date().toISOString(),
        status: 'operational',
        latency_ms: 123,
      });
      expect(await claimServiceStatusCheck()).toBeNull();
      const schedule = await state.pool!.query(
        'SELECT EXTRACT(EPOCH FROM next_check_at-now()) AS seconds,lease_token FROM ai_service_status_schedule',
      );
      expect(Number(schedule.rows[0].seconds)).toBeGreaterThan(21598);
      expect(Number(schedule.rows[0].seconds)).toBeLessThanOrEqual(21600);
      expect(schedule.rows[0].lease_token).toBeNull();
      expect(await listServiceStatusChecks()).toEqual([
        {
          checked_at: expect.any(String),
          status: 'operational',
          latency_ms: 123,
        },
      ]);
    });
    it('fences late and duplicate results so they cannot replace a newer check', async () => {
      const old = (await claimServiceStatusCheck())!;
      await state.pool!.query(
        "UPDATE ai_service_status_schedule SET next_check_at=now()-interval '1 second',lease_until=now()-interval '1 second'",
      );
      const next = (await claimServiceStatusCheck())!;
      await completeServiceStatusCheck(old, {
        checked_at: new Date().toISOString(),
        status: 'unavailable',
        latency_ms: null,
      });
      expect(await listServiceStatusChecks()).toEqual([]);
      const sample = {
        checked_at: new Date().toISOString(),
        status: 'operational' as const,
        latency_ms: 45,
      };
      await completeServiceStatusCheck(next, sample);
      await completeServiceStatusCheck(next, sample);
      expect(await listServiceStatusChecks()).toEqual([sample]);
    });
    it('bounds public history and removes records older than seven days', async () => {
      await state.pool!
        .query(`INSERT INTO ai_service_status_checks (checked_at,status,latency_ms)
      SELECT now()-make_interval(hours=>n*6),'operational',20 FROM generate_series(1,40) n`);
      expect(await listServiceStatusChecks()).toHaveLength(28);
      const token = (await claimServiceStatusCheck())!;
      await completeServiceStatusCheck(token, {
        checked_at: new Date().toISOString(),
        status: 'unavailable',
        latency_ms: null,
      });
      const expired = await state.pool!.query(
        "SELECT count(*) AS count FROM ai_service_status_checks WHERE checked_at<now()-interval '7 days'",
      );
      expect(Number(expired.rows[0].count)).toBe(0);
    });
  },
);
