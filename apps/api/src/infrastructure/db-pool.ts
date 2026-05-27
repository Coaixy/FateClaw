import pg from 'pg';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export type DbQueryable = pg.Pool | pg.PoolClient;

export function initDbPool(connectionString: string): pg.Pool {
  if (pool) {
    return pool;
  }
  pool = new Pool({ connectionString });
  return pool;
}

export function getDbPool(): pg.Pool {
  if (!pool) {
    throw new Error('数据库未初始化');
  }
  return pool;
}

export async function closeDbPool(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
}
