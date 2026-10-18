import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  closeAgentDb,
  getAgentDbPool,
  querySoulContent,
  updateSoulContentDb,
} from '#agent/agent-db';

// Explicit opt-in must point to a disposable database owned by the test runner.
const connectionString = process.env.FATECLAW_TEST_DATABASE_URL;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

describe.skipIf(!connectionString)('Soul PostgreSQL concurrency', () => {
  let setup: pg.Pool;
  beforeAll(async () => {
    process.env.DATABASE_URL = connectionString!;
    setup = new pg.Pool({ connectionString });
    await setup.query(`CREATE TABLE users (id text PRIMARY KEY, soul_content text);
      CREATE TABLE accounts (id text PRIMARY KEY, owner_id text REFERENCES users(id),
      soul_content text, enabled boolean DEFAULT true, created_at timestamptz DEFAULT now())`);
  });
  beforeEach(async () => {
    await setup.query('TRUNCATE accounts, users');
    await setup.query("INSERT INTO users VALUES ('user-1', 'original')");
  });
  afterAll(async () => {
    await closeAgentDb();
    await setup.query('DROP TABLE accounts, users');
    await setup.end();
  });

  it('allows exactly one concurrent edit against the same baseHash', async () => {
    const results = await Promise.all([
      updateSoulContentDb('web:user-1', 'first', hash('original')),
      updateSoulContentDb('web:user-1', 'second', hash('original')),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await querySoulContent('web:user-1')).toBe(
      results[0] ? 'first' : 'second',
    );
  });

  it('rejects an edit waiting behind an uncommitted Dashboard write', async () => {
    const dashboard = await setup.connect();
    try {
      await dashboard.query('BEGIN');
      await dashboard.query(
        "UPDATE users SET soul_content='dashboard' WHERE id='user-1'",
      );
      const edit = updateSoulContentDb('web:user-1', 'agent', hash('original'));
      // Observe the actual lock wait before releasing the Dashboard transaction.
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const result = await setup.query(`SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock'
          AND query LIKE 'SELECT soul_content FROM users%'`);
        if (result.rowCount) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await dashboard.query('COMMIT');
      expect(await edit).toBe(false);
      expect(await querySoulContent('web:user-1')).toBe('dashboard');
    } finally {
      await dashboard.query('ROLLBACK');
      dashboard.release();
    }
  });

  it('preserves fallback reads while migrating a web edit to its canonical user', async () => {
    await setup.query("UPDATE users SET soul_content='' WHERE id='user-1'");
    await setup.query(
      "INSERT INTO accounts(id,owner_id,soul_content) VALUES ('account-1','user-1','legacy')",
    );
    expect(
      await updateSoulContentDb('web:user-1', 'canonical', hash('legacy')),
    ).toBe(true);
    expect(await querySoulContent('account-1')).toBe('canonical');
    const { rows } = await setup.query(
      "SELECT soul_content FROM accounts WHERE id='account-1'",
    );
    expect(rows[0].soul_content).toBe('legacy');
  });

  it('applies server timeouts and bounds pool exhaustion', async () => {
    const clients = await Promise.all([
      getAgentDbPool().connect(),
      getAgentDbPool().connect(),
    ]);
    try {
      expect(
        (await clients[0].query('SHOW statement_timeout')).rows[0]
          .statement_timeout,
      ).toBe('30s');
      expect(
        (await clients[0].query('SHOW idle_in_transaction_session_timeout'))
          .rows[0].idle_in_transaction_session_timeout,
      ).toBe('15s');
      await expect(getAgentDbPool().connect()).rejects.toThrow('timeout');
      await clients[0].query('BEGIN');
      await clients[0].query("SET LOCAL statement_timeout='20ms'");
      await expect(
        clients[0].query('SELECT pg_sleep(1)'),
      ).rejects.toMatchObject({ code: '57014' });
      await clients[0].query('ROLLBACK');
    } finally {
      clients.forEach((client) => client.release());
    }
  }, 10_000);
});
