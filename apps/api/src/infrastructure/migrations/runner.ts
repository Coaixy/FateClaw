import type pg from 'pg';

import {
  BASELINES,
  MIGRATIONS,
  validateMigrationManifest,
} from './manifest.js';
import type { DatabaseMigration } from './types.js';

const MIGRATION_LOCK_KEY = [708527, 1];

async function ensureMigrationTable(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function assertEmptySchema(client: pg.PoolClient): Promise<void> {
  const { rows } = await client.query<{ has_schema_objects: boolean }>(`
    WITH RECURSIVE allowed_objects (class_id, object_id) AS (
      (
        SELECT 'pg_class'::regclass::oid, 'public.schema_migrations'::regclass::oid
        UNION
        SELECT 'pg_extension'::regclass::oid, oid FROM pg_extension
        UNION
        SELECT classid, objid FROM pg_depend WHERE deptype = 'e'
      )
      UNION
      SELECT d.classid, d.objid FROM pg_depend d
      JOIN allowed_objects a ON a.class_id = d.refclassid AND a.object_id = d.refobjid
      WHERE d.deptype IN ('a', 'i')
    )
    SELECT EXISTS (
      SELECT 1 FROM pg_depend d
      WHERE d.refclassid = 'pg_namespace'::regclass
        AND d.refobjid = 'public'::regnamespace
        AND NOT EXISTS (
          SELECT 1 FROM allowed_objects a
          WHERE a.class_id = d.classid AND a.object_id = d.objid
        )
    ) AS has_schema_objects
  `);

  // An empty ledger alone does not establish that existing objects can be replaced.
  if (rows[0]?.has_schema_objects !== false) {
    throw new Error(
      'Database schema is not empty but has no migration history',
    );
  }
}

async function inMigrationTransaction(
  client: pg.PoolClient,
  apply: () => Promise<void>,
): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query(
      "SET LOCAL idle_in_transaction_session_timeout = '120s'",
    );
    await apply();
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function recordMigration(
  client: pg.PoolClient,
  migration: DatabaseMigration,
): Promise<void> {
  await client.query(
    `INSERT INTO schema_migrations (id, description)
     VALUES ($1, $2)`,
    [migration.id, migration.description],
  );
}

export async function runDatabaseMigrations(
  client: pg.PoolClient,
): Promise<void> {
  validateMigrationManifest(MIGRATIONS, BASELINES);
  await client.query('SELECT pg_advisory_lock($1, $2)', MIGRATION_LOCK_KEY);
  try {
    await ensureMigrationTable(client);
    const { rows } = await client.query<{ id: string }>(
      'SELECT id FROM schema_migrations',
    );
    const appliedIds = new Set(rows.map((row) => row.id));

    if (appliedIds.size === 0) {
      await assertEmptySchema(client);
      const baseline = BASELINES[BASELINES.length - 1];
      const boundary = MIGRATIONS.findIndex(
        (migration) => migration.id === baseline.throughMigrationId,
      );
      const covered = MIGRATIONS.slice(0, boundary + 1);

      // Schema and covered IDs must commit together so retries never misclassify a partial bootstrap.
      await inMigrationTransaction(client, async () => {
        await baseline.up(client);
        for (const migration of covered)
          await recordMigration(client, migration);
      });
      for (const migration of covered) appliedIds.add(migration.id);
    }

    for (const migration of MIGRATIONS) {
      if (appliedIds.has(migration.id)) continue;
      await inMigrationTransaction(client, async () => {
        await migration.up(client);
        await recordMigration(client, migration);
      });
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1, $2)', MIGRATION_LOCK_KEY);
  }
}
