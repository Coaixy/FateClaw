import { describe, expect, it } from 'vitest';

import { queryOne, queryResult, queryRows } from '#infrastructure/typed-query';

interface QueryCall {
  sql: string;
  params?: unknown[];
}

function createQueryable(rows: unknown[]) {
  const calls: QueryCall[] = [];
  const queryable = {
    async query<Row>(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      return { rows: rows as Row[], rowCount: rows.length };
    },
  };
  return { calls, queryable };
}

describe('typed query helpers', () => {
  it('returns typed row arrays and forwards params', async () => {
    const { calls, queryable } = createQueryable([{ id: 'user-1' }]);

    await expect(
      queryRows<{ id: string }>(queryable as never, 'SELECT id FROM users', [
        'user-1',
      ]),
    ).resolves.toEqual([{ id: 'user-1' }]);

    expect(calls).toEqual([
      { sql: 'SELECT id FROM users', params: ['user-1'] },
    ]);
  });

  it('returns the first row for queryOne', async () => {
    const { queryable } = createQueryable([{ id: 'first' }, { id: 'second' }]);

    await expect(
      queryOne<{ id: string }>(queryable as never, 'SELECT id FROM users'),
    ).resolves.toEqual({ id: 'first' });
  });

  it('preserves the query result when callers need rowCount', async () => {
    const { queryable } = createQueryable([{ id: 'user-1' }]);

    await expect(
      queryResult<{ id: string }>(queryable as never, 'DELETE FROM users'),
    ).resolves.toMatchObject({ rowCount: 1 });
  });
});
