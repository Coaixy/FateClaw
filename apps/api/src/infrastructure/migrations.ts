import type pg from 'pg';

import { MIGRATIONS } from './migrations/definitions.js';
export type { DatabaseMigration } from './migrations/types.js';

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

/**
 * 按顺序执行尚未记录的数据库迁移。
 *
 * @param client PostgreSQL 连接池客户端；调用方负责提供可用连接。
 * @returns 所有未执行迁移提交完成后返回。
 * @remarks 通过 PostgreSQL advisory lock 串行化多实例启动，单个迁移失败会回滚该迁移事务并继续抛错。
 */
export async function runDatabaseMigrations(
  client: pg.PoolClient,
): Promise<void> {
  // 多实例启动时串行执行迁移，避免 schema_migrations 唯一键竞争导致启动失败。
  await client.query('SELECT pg_advisory_lock($1, $2)', MIGRATION_LOCK_KEY);
  try {
    await ensureMigrationTable(client);

    const { rows } = await client.query<{ id: string }>(
      'SELECT id FROM schema_migrations',
    );
    const appliedIds = new Set(rows.map((row) => row.id));

    for (const migration of MIGRATIONS) {
      if (appliedIds.has(migration.id)) continue;

      await client.query('BEGIN');
      try {
        await migration.up(client);
        await client.query(
          `INSERT INTO schema_migrations (id, description)
           VALUES ($1, $2)`,
          [migration.id, migration.description],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1, $2)', MIGRATION_LOCK_KEY);
  }
}
