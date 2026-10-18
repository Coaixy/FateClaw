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
vi.mock('#infrastructure/db-pool', () => ({
  getDbPool: () => state.pool,
}));
import { MIGRATIONS } from '#infrastructure/migrations/manifest';
import {
  claimServiceStatusCheck,
  completeServiceStatusCheck,
  listServiceStatusChecks,
  getServiceTokenUsage,
} from '#infrastructure/repositories/service-status-repository';

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

    it('sums recorded totals across accounts and fills seven UTC days without exposing account details', async () => {
      const empty = await getServiceTokenUsage();
      expect(empty.total_tokens).toBe(0);
      expect(empty.today_tokens).toBe(0);
      expect(empty.daily).toHaveLength(7);
      expect(empty.daily.every((point) => point.tokens === 0)).toBe(true);
      const first = randomUUID();
      const second = randomUUID();
      await state.pool!.query(
        `INSERT INTO users (id,phone,phone_verified,created_at)
         VALUES ($1,'19900000001',true,now()),($2,'19900000002',true,now())`,
        [first, second],
      );
      await state.pool!.query(
        `INSERT INTO daily_usage (user_id,date,input_tokens,output_tokens,total_tokens)
         VALUES
           ($1,((now() AT TIME ZONE 'UTC')::date)::text,3,4,400000000),
           ($2,((now() AT TIME ZONE 'UTC')::date)::text,3,4,500000000),
           ($1,((now() AT TIME ZONE 'UTC')::date-1)::text,3,4,350000),
           ($1,((now() AT TIME ZONE 'UTC')::date-40)::text,3,4,2000000000)`,
        [first, second],
      );
      const usage = await getServiceTokenUsage();
      expect(usage.total_tokens).toBe(2_900_350_000);
      expect(usage.today_tokens).toBe(900_000_000);
      expect(usage.daily).toHaveLength(7);
      expect(
        usage.daily.slice(0, -2).every((point) => point.tokens === 0),
      ).toBe(true);
      expect(usage.daily.at(-2)?.tokens).toBe(350_000);
      expect(usage.daily.at(-1)).toEqual({
        date: usage.updated_at.slice(0, 10),
        tokens: 900_000_000,
      });
      expect(usage.daily.map((point) => point.date)).toEqual(
        usage.daily.map((point) => point.date).sort(),
      );
      expect(JSON.stringify(usage)).not.toContain(first);
      expect(JSON.stringify(usage)).not.toContain(second);
    });
  },
);
