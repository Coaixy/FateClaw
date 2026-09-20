import pg from 'pg';

import { logger } from './logger.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export type DbQueryable = pg.Pool | pg.PoolClient;

export function initDbPool(connectionString: string): pg.Pool {
  if (pool) {
    return pool;
  }
  pool = new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 30_000,
    query_timeout: 125_000,
    idle_in_transaction_session_timeout: 15_000,
  });
  pool.on('error', () => {
    // Do not log connection details; pg removes this idle client automatically.
    logger.error('Database idle connection failed; client removed from pool');
  });
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
