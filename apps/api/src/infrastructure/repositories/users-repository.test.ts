import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetDbPool } = vi.hoisted(() => ({
  mockGetDbPool: vi.fn(),
}));

vi.mock('../db-pool.js', () => ({
  getDbPool: mockGetDbPool,
}));

import {
  createUser,
  getUserByAccountId,
  getUserByIdUsing,
  promoteUserToCreator,
  updateUserPasswordHash,
} from './users-repository.js';
import type { User } from '../../shared/types.js';

interface QueryCall {
  sql: string;
  params?: unknown[];
}

function user(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    phone: '13800138000',
    phone_verified: true,
    password_hash: 'hash',
    role: 'consumer',
    purchased_points: 0,
    bonus_points: 0,
    earned_points: 0,
    reserved_points: 0,
    pending_withdrawal_points: 0,
    created_at: '2026-05-27T00:00:00.000Z',
    ...overrides,
  };
}

function createMockPool(
  rowsBySql: Array<{ match: string; rows: unknown[] }> = [],
) {
  const calls: QueryCall[] = [];
  const pool = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      const result = rowsBySql.find((item) => sql.includes(item.match));
      return { rows: result?.rows ?? [] };
    },
  };
  mockGetDbPool.mockReturnValue(pool);
  return { calls, pool };
}

describe('users repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts all persisted user point columns', async () => {
    const { calls } = createMockPool();
    const input = user({ purchased_points: 100, bonus_points: 20 });

    await createUser(input);

    expect(calls[0]?.sql).toContain('INSERT INTO users');
    expect(calls[0]?.params).toEqual([
      input.id,
      input.phone,
      input.phone_verified,
      input.password_hash,
      input.role,
      input.purchased_points,
      input.bonus_points,
      input.earned_points,
      input.reserved_points,
      input.pending_withdrawal_points,
      input.created_at,
    ]);
  });

  it('supports FOR UPDATE when querying users inside transactions', async () => {
    const { calls, pool } = createMockPool([
      { match: 'FROM users u', rows: [user()] },
    ]);

    await expect(
      getUserByIdUsing(pool as never, 'user-1', { forUpdate: true }),
    ).resolves.toMatchObject({ id: 'user-1' });

    expect(calls[0]?.sql).toContain('FOR UPDATE OF u');
    expect(calls[0]?.params).toEqual(['user-1']);
  });

  it('returns the updated user after changing password hash', async () => {
    const nextUser = user({ password_hash: 'next-hash' });
    const { calls } = createMockPool([
      { match: 'FROM users u', rows: [nextUser] },
    ]);

    await expect(
      updateUserPasswordHash('user-1', 'next-hash'),
    ).resolves.toMatchObject({ password_hash: 'next-hash' });

    expect(calls[0]).toEqual({
      sql: 'UPDATE users SET password_hash = $1 WHERE id = $2',
      params: ['next-hash', 'user-1'],
    });
  });

  it('looks up a user through an owned account', async () => {
    const { calls } = createMockPool([
      { match: 'JOIN accounts', rows: [user()] },
    ]);

    await expect(getUserByAccountId('account-1')).resolves.toMatchObject({
      id: 'user-1',
    });

    expect(calls[0]?.sql).toContain('JOIN accounts a ON a.owner_id = u.id');
    expect(calls[0]?.params).toEqual(['account-1']);
  });

  it('promotes consumers to both role while preserving admin role', async () => {
    const { calls } = createMockPool([
      { match: 'RETURNING role', rows: [{ role: 'both' }] },
    ]);

    await expect(promoteUserToCreator('user-1')).resolves.toBe('both');

    expect(calls[0]?.sql).toContain("WHEN 'consumer' THEN 'both'");
    expect(calls[0]?.sql).toContain("WHEN 'admin' THEN 'admin'");
    expect(calls[0]?.params).toEqual(['user-1']);
  });
});
