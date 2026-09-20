import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { created, logError } = vi.hoisted(() => ({
  created: [] as Array<{ options: Record<string, unknown>; pool: unknown }>,
  logError: vi.fn(),
}));

vi.mock('../../src/infrastructure/logger.js', () => ({
  logger: { error: logError },
}));
vi.mock('pg', () => ({
  default: {
    Pool: class extends EventEmitter {
      end = vi.fn(async () => {});
      constructor(options: Record<string, unknown>) {
        super();
        created.push({ options, pool: this });
      }
    },
  },
}));

import { closeDbPool, initDbPool } from '../../src/infrastructure/db-pool.js';

afterEach(async () => {
  await closeDbPool();
  created.length = 0;
  vi.clearAllMocks();
});

describe('API database pool', () => {
  it('bounds acquisition and both database and network query waits', () => {
    const pool = initDbPool('postgres://synthetic/test');
    expect(initDbPool('postgres://synthetic/unused')).toBe(pool);
    expect(created).toHaveLength(1);
    expect(created[0].options).toMatchObject({
      max: 10,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 30_000,
      query_timeout: 125_000,
      idle_in_transaction_session_timeout: 15_000,
    });
  });

  it('handles idle disconnects without exposing error connection details', () => {
    const pool = initDbPool('postgres://synthetic/test');
    expect(() =>
      pool.emit('error', new Error('synthetic sensitive connection detail')),
    ).not.toThrow();
    expect(logError).toHaveBeenCalledExactlyOnceWith(
      'Database idle connection failed; client removed from pool',
    );
  });
});
