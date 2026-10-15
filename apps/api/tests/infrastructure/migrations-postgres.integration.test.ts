import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../../src/infrastructure/migrations/manifest.js';
import { runDatabaseMigrations } from '../../src/infrastructure/migrations/runner.js';

// This opt-in connection must point to a disposable server with CREATE DATABASE permission.
const connectionString = process.env.FATECLAW_TEST_MIGRATIONS_DATABASE_URL;

describe.skipIf(!connectionString)(
  'database migrations PostgreSQL integration',
  () => {
    let admin: pg.Pool;

    beforeAll(() => {
      admin = new pg.Pool({ connectionString, connectionTimeoutMillis: 5000 });
    });

    afterAll(async () => {
      await admin.end();
    });

    async function withDatabase(
      work: (client: pg.PoolClient, pool: pg.Pool) => Promise<void>,
    ) {
      const name = `fateclaw_migrations_test_${randomUUID().replaceAll('-', '')}`;
      await admin.query(`CREATE DATABASE "${name}"`);
      const url = new URL(connectionString!);
      url.pathname = `/${name}`;
      const pool = new pg.Pool({
        connectionString: url.toString(),
        connectionTimeoutMillis: 5000,
        query_timeout: 125000,
        statement_timeout: 30000,
      });
      let client: pg.PoolClient | undefined;
      try {
        client = await pool.connect();
        await work(client, pool);
      } finally {
        client?.release();
        await pool.end();
        await admin.query(`DROP DATABASE "${name}"`);
      }
    }

    async function replayHistory(client: pg.PoolClient, throughId?: string) {
      await client.query(`CREATE TABLE schema_migrations (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
      for (const migration of MIGRATIONS) {
        if (throughId && migration.id > throughId) break;
        await client.query('BEGIN');
        try {
          await migration.up(client);
          await client.query(
            'INSERT INTO schema_migrations (id, description) VALUES ($1, $2)',
            [migration.id, migration.description],
          );
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      }
    }

    async function readSchema(client: pg.PoolClient) {
      const columns = await client.query(`
      SELECT c.relname, c.relkind, a.attnum, a.attname,
        format_type(a.atttypid, a.atttypmod) AS type,
        a.attnotnull, pg_get_expr(d.adbin, d.adrelid) AS default_value,
        col_description(c.oid, a.attnum) AS comment
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
      LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND c.relname <> 'schema_migrations' AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY c.relname, a.attnum
    `);
      const constraints = await client.query(`
      SELECT c.relname, t.conname, t.contype,
        pg_get_constraintdef(t.oid, true) AS definition
      FROM pg_constraint t
      JOIN pg_class c ON c.oid = t.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname <> 'schema_migrations'
      ORDER BY c.relname, t.conname
    `);
      const indexes = await client.query(`
      SELECT tablename, indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename <> 'schema_migrations'
      ORDER BY tablename, indexname
    `);
      const comments = await client.query(`
      SELECT c.relname, obj_description(c.oid, 'pg_class') AS comment
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND c.relname <> 'schema_migrations' ORDER BY c.relname
    `);
      const extensions = await client.query(
        'SELECT extname, extversion FROM pg_extension ORDER BY extname',
      );
      return {
        columns: columns.rows,
        constraints: constraints.rows,
        indexes: indexes.rows,
        comments: comments.rows,
        extensions: extensions.rows,
      };
    }

    async function readSeedFingerprints(client: pg.PoolClient) {
      const { rows } = await client.query<{ tablename: string }>(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> 'schema_migrations'
      ORDER BY tablename
    `);
      const fingerprints: Record<string, string> = {};
      for (const { tablename } of rows) {
        const table = `public."${tablename.replaceAll('"', '""')}"`;
        const result = await client.query<{ fingerprint: string }>(`
        SELECT md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text, '[]')) AS fingerprint
        FROM ${table} t
      `);
        fingerprints[tablename] = result.rows[0].fingerprint;
      }
      return fingerprints;
    }

    it('converges a fresh baseline and the historical chain to the same schema and default seeds', async () => {
      await withDatabase(async (legacy) => {
        await replayHistory(legacy);
        const expectedSchema = await readSchema(legacy);
        const expectedSeeds = await readSeedFingerprints(legacy);
        expect(expectedSeeds).not.toHaveProperty(
          'public_financial_ledger_entries',
        );
        expect(expectedSeeds).not.toHaveProperty('announcements');
        expect(expectedSeeds).not.toHaveProperty('redemption_codes');
        await withDatabase(async (fresh) => {
          await runDatabaseMigrations(fresh);
          expect(await readSchema(fresh)).toEqual(expectedSchema);
          expect(await readSeedFingerprints(fresh)).toEqual(expectedSeeds);
          const { rows } = await fresh.query(
            'SELECT id FROM schema_migrations ORDER BY id',
          );
          expect(rows.map((row) => row.id)).toEqual(
            MIGRATIONS.map((migration) => migration.id),
          );
        });
      });
    }, 30000);

    it.each([
      { name: 'FateClaw Clarity', expectedName: '卦师使用权' },
      {
        name: 'Synthetic custom membership',
        expectedName: 'Synthetic custom membership',
      },
    ])(
      'unifies membership identity while preserving configured values and user state: $name',
      async ({ name, expectedName }) => {
        await withDatabase(async (client) => {
          await replayHistory(client, '0080_drop_redemption_codes');
          const config = await client.query(
            `
          UPDATE membership_config SET name = $1, enabled = false,
            monthly_price_coins = 37.25, display_price_coins = 66
          RETURNING *
        `,
            [name],
          );
          await client.query(`INSERT INTO users (id, created_at, purchased_coins)
          VALUES ('synthetic-member', NOW(), 123.45),
                 ('synthetic-cancelled-member', NOW(), 0),
                 ('synthetic-expired-member', NOW(), 0),
                 ('synthetic-new-member', NOW(), 0)`);
          const memberships = await client.query(`
          INSERT INTO user_memberships
            (user_id, plan_key, status, current_period_start, current_period_end)
          VALUES
            ('synthetic-member', 'fateclaw_clarity', 'active', NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 month'),
            ('synthetic-cancelled-member', 'fateclaw_plus', 'cancelled', NOW() - INTERVAL '1 month', NOW() - INTERVAL '1 day'),
            ('synthetic-expired-member', 'fateclaw_clarity', 'active', NOW() - INTERVAL '2 months', NOW() - INTERVAL '1 month')
          RETURNING *
        `);
          await client.query(`INSERT INTO wallet_transactions
          (id, user_id, kind, amount_coins, note, metadata)
          VALUES ('synthetic-membership-purchase', 'synthetic-member',
            'membership_subscription', -37.25, 'Synthetic purchase',
            '{"planKey":"fateclaw_clarity"}'::jsonb)`);
          const before = await readSeedFingerprints(client);

          await runDatabaseMigrations(client);

          expect(
            (await client.query('SELECT * FROM membership_config')).rows,
          ).toEqual([
            { ...config.rows[0], id: 'membership', name: expectedName },
          ]);
          expect(
            (
              await client.query(
                'SELECT * FROM user_memberships ORDER BY user_id',
              )
            ).rows,
          ).toEqual(
            memberships.rows
              .map((row) => ({ ...row, plan_key: 'membership' }))
              .sort((a, b) => a.user_id.localeCompare(b.user_id)),
          );
          const after = await readSeedFingerprints(client);
          expect(after.users).toBe(before.users);
          expect(after.wallet_transactions).toBe(before.wallet_transactions);

          const created = await client.query(`INSERT INTO user_memberships
          (user_id, status, current_period_start, current_period_end)
          VALUES ('synthetic-new-member', 'active', NOW(), NOW() + INTERVAL '1 month')
          RETURNING plan_key`);
          expect(created.rows).toEqual([{ plan_key: 'membership' }]);
          await expect(
            client.query(`UPDATE user_memberships SET plan_key = 'unknown'
          WHERE user_id = 'synthetic-new-member'`),
          ).rejects.toMatchObject({ code: '23514' });
          await expect(
            client.query("UPDATE membership_config SET id = 'unknown'"),
          ).rejects.toMatchObject({ code: '23514' });

          await runDatabaseMigrations(client);
          expect(
            (await client.query('SELECT * FROM membership_config')).rows[0],
          ).toEqual({
            ...config.rows[0],
            id: 'membership',
            name: expectedName,
          });
        });
      },
    );

    it('upgrades through 0075 without replaying cleanup or changing existing user data', async () => {
      await withDatabase(async (client) => {
        await replayHistory(client, '0075_add_redemption_codes');
        await client.query(`INSERT INTO users (id, created_at, purchased_coins)
        VALUES ('synthetic-preserved-user', NOW(), 123.45)`);
        await client.query(`INSERT INTO bazi_cases (id, bazi, gender)
        VALUES (1, 'synthetic fixture', 'synthetic')`);
        await client.query(`INSERT INTO public_financial_ledger_entries
        (id, entry_type, occurred_at, content, amount_yuan)
        VALUES ('synthetic-retired-entry', 'expense', '2026-10-08', 'Synthetic fixture', 1)`);
        await client.query(`INSERT INTO announcements
        (id, slug, title, summary, body_markdown, status, priority)
        VALUES ('synthetic-retired-announcement', 'synthetic-announcement',
          'Synthetic title', '', 'Synthetic body', 'published', 0)`);
        await client.query(`INSERT INTO redemption_codes (id, code, amount_coins)
        VALUES ('synthetic-retired-code', 'SYNTHETIC-RETIRED-CODE', 10)`);
        await client.query(`INSERT INTO balance_grants
        (id, user_id, source, amount_coins, remaining_coins)
        VALUES ('synthetic-preserved-grant', 'synthetic-preserved-user',
          'redemption_code', 20, 15)`);
        await client.query(`UPDATE users SET bonus_coins = 15
        WHERE id = 'synthetic-preserved-user'`);
        await client.query(`INSERT INTO wallet_transactions
        (id, user_id, kind, amount_coins, balance_source, balance_grant_id)
        VALUES ('synthetic-preserved-transaction', 'synthetic-preserved-user',
          'bonus_grant', 20, 'bonus', 'synthetic-preserved-grant')`);
        const preservedTables = [
          'users',
          'balance_grants',
          'wallet_transactions',
        ];
        const beforeUpgrade = await readSeedFingerprints(client);
        await runDatabaseMigrations(client);
        expect(
          (
            await client.query(
              "SELECT to_regclass('public.redemption_codes') AS name",
            )
          ).rows[0].name,
        ).toBeNull();
        const afterUpgrade = await readSeedFingerprints(client);
        for (const table of preservedTables) {
          expect(afterUpgrade[table]).toBe(beforeUpgrade[table]);
        }
        expect(
          (
            await client.query(
              "SELECT to_regclass('public.announcements') AS name",
            )
          ).rows[0].name,
        ).toBeNull();
        expect(
          (
            await client.query(
              "SELECT to_regclass('public.public_financial_ledger_entries') AS name",
            )
          ).rows[0].name,
        ).toBeNull();
        expect(
          (
            await client.query(
              "SELECT to_regclass('public.bazi_cases') AS name",
            )
          ).rows[0].name,
        ).toBeNull();
        expect(
          (
            await client.query(
              "SELECT to_regclass('public.agent_requests') AS name",
            )
          ).rows[0].name,
        ).toBe('agent_requests');
        expect(
          (
            await client.query(
              "SELECT purchased_coins FROM users WHERE id = 'synthetic-preserved-user'",
            )
          ).rows[0].purchased_coins,
        ).toBe('123.45');
        const { rows } = await client.query(
          'SELECT id, applied_at FROM schema_migrations ORDER BY id',
        );
        await runDatabaseMigrations(client);
        expect(
          (
            await client.query(
              'SELECT id, applied_at FROM schema_migrations ORDER BY id',
            )
          ).rows,
        ).toEqual(rows);
      });
    }, 30000);

    it('allows preinstalled extension objects in an otherwise empty schema', async () => {
      await withDatabase(async (client) => {
        await client.query('CREATE EXTENSION pg_trgm WITH SCHEMA public');
        await runDatabaseMigrations(client);
        expect(
          (
            await client.query(
              'SELECT count(*)::int AS count FROM schema_migrations',
            )
          ).rows[0].count,
        ).toBe(MIGRATIONS.length);
      });
    });

    it.each([
      ['table', 'CREATE TABLE synthetic_marker (id INTEGER)'],
      ['view', 'CREATE VIEW synthetic_marker AS SELECT 1 AS id'],
      ['sequence', 'CREATE SEQUENCE synthetic_marker'],
      [
        'function',
        "CREATE FUNCTION synthetic_marker() RETURNS INTEGER LANGUAGE SQL AS 'SELECT 1'",
      ],
      ['domain', 'CREATE DOMAIN synthetic_marker AS TEXT'],
      ['composite type', 'CREATE TYPE synthetic_marker AS (id INTEGER)'],
      ['collation', "CREATE COLLATION synthetic_marker (locale = 'C')"],
    ])('rejects an untracked schema containing a %s', async (_kind, sql) => {
      await withDatabase(async (client) => {
        await client.query(sql);
        await expect(runDatabaseMigrations(client)).rejects.toThrow(
          'no migration history',
        );
        expect(
          (await client.query("SELECT to_regclass('public.users') AS name"))
            .rows[0].name,
        ).toBeNull();
        expect(
          (
            await client.query(
              'SELECT count(*)::int AS count FROM schema_migrations',
            )
          ).rows[0].count,
        ).toBe(0);
      });
    });

    it('rolls back schema and covered IDs together, releases the lock and permits retry', async () => {
      await withDatabase(async (client) => {
        const failingClient = {
          query: async (sql: string, params?: unknown[]) => {
            if (params?.[0] === '0071_cleanup_invalid_phone_users') {
              return client.query('SELECT 1 / 0');
            }
            return client.query(sql, params);
          },
        } as pg.PoolClient;
        await expect(
          runDatabaseMigrations(failingClient),
        ).rejects.toMatchObject({ code: '22012' });
        expect(
          (await client.query("SELECT to_regclass('public.users') AS name"))
            .rows[0].name,
        ).toBeNull();
        expect(
          (
            await client.query(
              'SELECT count(*)::int AS count FROM schema_migrations',
            )
          ).rows[0].count,
        ).toBe(0);
        expect(
          (
            await client.query(
              "SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()",
            )
          ).rows[0].count,
        ).toBe(0);
        await runDatabaseMigrations(client);
        expect(
          (
            await client.query(
              'SELECT count(*)::int AS count FROM schema_migrations',
            )
          ).rows[0].count,
        ).toBe(MIGRATIONS.length);
      });
    });

    it('serializes concurrent first startups', async () => {
      await withDatabase(async (first, pool) => {
        const peer = await pool.connect();
        try {
          await Promise.all([
            runDatabaseMigrations(first),
            runDatabaseMigrations(peer),
          ]);
          expect(
            (
              await first.query(
                'SELECT count(*)::int AS count FROM schema_migrations',
              )
            ).rows[0].count,
          ).toBe(MIGRATIONS.length);
        } finally {
          peer.release();
        }
      });
    });
  },
);
