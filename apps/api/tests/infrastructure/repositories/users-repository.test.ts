import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetDbPool } = vi.hoisted(() => ({
  mockGetDbPool: vi.fn(),
}));

vi.mock('../../../src/infrastructure/db-pool.js', () => ({
  getDbPool: mockGetDbPool,
}));

import {
  createUser,
  getUserByAccountId,
  getUserByIdUsing,
  getUserByOAuthIdentityUsing,
  listUsersPageForAdmin,
  promoteUserToCreator,
  updateUserPasswordHash,
  upsertOAuthIdentityUsing,
} from '../../../src/infrastructure/repositories/users-repository.js';
import type { User } from '../../../src/shared/types.js';

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
    purchased_coins: 0,
    bonus_coins: 0,
    reserved_coins: 0,
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

  it('inserts all persisted user balance columns', async () => {
    const { calls } = createMockPool();
    const input = user({ purchased_coins: 100, bonus_coins: 20 });

    await createUser(input);

    expect(calls[0]?.sql).toContain('INSERT INTO users');
    expect(calls[0]?.params).toEqual([
      input.id,
      input.phone,
      input.phone_verified,
      input.password_hash,
      input.role,
      input.purchased_coins,
      input.bonus_coins,
      input.reserved_coins,
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

  it('returns the updated user after changing password hash and token version', async () => {
    const nextUser = {
      ...user({ password_hash: 'next-hash' }),
      auth_token_version: 1,
    };
    const { calls } = createMockPool([
      { match: 'FROM users u', rows: [nextUser] },
    ]);

    await expect(
      updateUserPasswordHash('user-1', 'next-hash'),
    ).resolves.toMatchObject({ password_hash: 'next-hash' });

    expect(calls[0]).toEqual({
      sql: `UPDATE users
     SET password_hash = $1,
         auth_token_version = auth_token_version + 1
     WHERE id = $2`,
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

  it('looks up a user through an oauth identity', async () => {
    const { calls, pool } = createMockPool([
      { match: 'JOIN user_oauth_identities', rows: [user()] },
    ]);

    await expect(
      getUserByOAuthIdentityUsing(pool as never, 'google', 'google-sub-1'),
    ).resolves.toMatchObject({ id: 'user-1' });

    expect(calls[0]?.sql).toContain('JOIN user_oauth_identities');
    expect(calls[0]?.params).toEqual(['google', 'google-sub-1']);
  });

  it('upserts oauth identity profile without rebinding user id on conflict', async () => {
    const { calls, pool } = createMockPool();

    await upsertOAuthIdentityUsing(pool as never, {
      provider: 'google',
      providerUserId: 'google-sub-1',
      userId: 'user-1',
      email: 'person@example.com',
      emailVerified: true,
      displayName: 'Person',
      avatarUrl: 'https://example.com/avatar.png',
      profileJson: { sub: 'google-sub-1' },
    });

    expect(calls[0]?.sql).toContain('ON CONFLICT (provider, provider_user_id)');
    expect(calls[0]?.sql).not.toContain('user_id = EXCLUDED.user_id');
    expect(calls[0]?.params).toEqual([
      'google',
      'google-sub-1',
      'user-1',
      'person@example.com',
      true,
      'Person',
      'https://example.com/avatar.png',
      JSON.stringify({ sub: 'google-sub-1' }),
    ]);
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

  it('uses index-friendly prefix search for admin ASCII user queries', async () => {
    const { calls } = createMockPool();

    await expect(
      listUsersPageForAdmin({
        limit: 20,
        offset: 0,
        query: 'user-',
      }),
    ).resolves.toEqual({
      users: [],
      total: 0,
    });

    expect(calls[0]?.sql).toContain('u.phone LIKE $1 OR u.id LIKE $1');
    expect(calls[0]?.sql).not.toContain('ILIKE $1');
    expect(calls[0]?.params).toEqual(['user-%', 20, 0]);
  });
});
