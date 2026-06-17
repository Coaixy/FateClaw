import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetDbPool, mockGetRedis, mockLoggerWarn } = vi.hoisted(() => ({
  mockGetDbPool: vi.fn(),
  mockGetRedis: vi.fn(),
  mockLoggerWarn: vi.fn(),
}));

vi.mock('../../../src/infrastructure/db-pool.js', () => ({
  getDbPool: mockGetDbPool,
}));

vi.mock('../../../src/infrastructure/redis.js', () => ({
  getRedis: mockGetRedis,
}));

vi.mock('../../../src/infrastructure/logger.js', () => ({
  logger: {
    warn: mockLoggerWarn,
  },
}));

import {
  deleteChatSession,
  getArchivedChatSessionsByUserId,
  getChatSessionPiSessionArchive,
  getRecentMessages,
  resetUserMessages,
  restoreArchivedChatSession,
  storeMessage,
} from '../../../src/infrastructure/repositories/chat-repository.js';
import type { NewMessage } from '../../../src/shared/types.js';

interface QueryCall {
  sql: string;
  params?: unknown[];
}

function message(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: 'message-1',
    account_id: 'account-1',
    sender: 'user-1',
    sender_name: '用户',
    content: 'hello',
    timestamp: '2026-05-27T00:00:00.000Z',
    is_from_me: false,
    is_bot_message: false,
    ...overrides,
  };
}

function createMockPool(rows: unknown[] = []) {
  const calls: QueryCall[] = [];
  const clientCalls: QueryCall[] = [];
  const client = {
    async query(sql: string, params?: unknown[]) {
      clientCalls.push({ sql, params });
      return { rows };
    },
    release: vi.fn(),
  };
  const pool = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      return { rows };
    },
    async connect() {
      return client;
    },
  };
  mockGetDbPool.mockReturnValue(pool);
  return { calls, clientCalls, client };
}

function createMockRedis() {
  const redis = {
    lpush: vi.fn(async () => 1),
    ltrim: vi.fn(async () => 'OK'),
  };
  mockGetRedis.mockReturnValue(redis);
  return redis;
}

describe('chat repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stores web chat messages without syncing them to Redis history', async () => {
    const { calls } = createMockPool();
    const redis = createMockRedis();

    await storeMessage(
      message({ session_id: 'session-1', metadata: { progress: true } }),
    );

    expect(calls[0]?.sql).toContain('INSERT INTO messages');
    expect(calls[0]?.params?.at(10)).toBe('session-1');
    expect(calls[0]?.params?.at(11)).toBe(JSON.stringify({ progress: true }));
    expect(mockGetRedis).not.toHaveBeenCalled();
    expect(redis.lpush).not.toHaveBeenCalled();
  });

  it('syncs non-session messages to Redis recall history', async () => {
    createMockPool();
    const redis = createMockRedis();

    await storeMessage(message({ is_from_me: true }));

    expect(redis.lpush).toHaveBeenCalledWith(
      'history:account-1',
      JSON.stringify({
        sender: 'user-1',
        sender_name: '用户',
        content: 'hello',
        timestamp: '2026-05-27T00:00:00.000Z',
        is_from_me: true,
      }),
    );
    expect(redis.ltrim).toHaveBeenCalledWith('history:account-1', 0, 499);
  });

  it('logs and keeps going when Redis history sync fails', async () => {
    createMockPool();
    mockGetRedis.mockReturnValue({
      lpush: vi.fn(async () => {
        throw new Error('redis down');
      }),
      ltrim: vi.fn(),
    });

    await expect(storeMessage(message())).resolves.toBeUndefined();

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'account-1' }),
      '消息同步到 Redis 失败',
    );
  });

  it('builds message history filters for session scoped reads', async () => {
    const { calls } = createMockPool([]);

    await getRecentMessages(
      'account-1',
      20,
      '2026-05-27T01:00:00.000Z',
      '2026-05-27T00:00:00.000Z',
      'session-1',
    );

    expect(calls[0]?.sql).toContain('session_id = $3');
    expect(calls[0]?.sql).toContain('timestamp < $4');
    expect(calls[0]?.sql).toContain('timestamp > $5');
    expect(calls[0]?.params).toEqual([
      'account-1',
      20,
      'session-1',
      '2026-05-27T01:00:00.000Z',
      '2026-05-27T00:00:00.000Z',
    ]);
  });

  it('soft deletes a chat session without scanning all messages', async () => {
    const { calls } = createMockPool();

    await deleteChatSession('session-1');

    expect(calls).toEqual([
      {
        sql: `UPDATE chat_sessions
     SET deleted_at = NOW(), share_token = NULL
     WHERE id = $1`,
        params: ['session-1'],
      },
    ]);
  });

  it('lists archived chat sessions for a user', async () => {
    const { calls } = createMockPool([]);

    await getArchivedChatSessionsByUserId('user-1', 20);

    expect(calls[0]?.sql).toContain('deleted_at IS NOT NULL');
    expect(calls[0]?.sql).toContain('ORDER BY deleted_at DESC');
    expect(calls[0]?.params).toEqual(['user-1', 20]);
  });

  it('restores an archived chat session owned by a user', async () => {
    const { calls } = createMockPool([
      {
        id: 'session-1',
        user_id: 'user-1',
        account_id: 'web:user-1',
        title: '旧会话',
        created_at: '2026-05-27T00:00:00.000Z',
        updated_at: '2026-05-27T01:00:00.000Z',
        deleted_at: null,
      },
    ]);

    const restored = await restoreArchivedChatSession({
      userId: 'user-1',
      sessionId: 'session-1',
    });

    expect(restored?.id).toBe('session-1');
    expect(calls[0]?.sql).toContain('SET deleted_at = NULL');
    expect(calls[0]?.sql).toContain('AND deleted_at IS NOT NULL');
    expect(calls[0]?.params).toEqual(['session-1', 'user-1']);
  });

  it('reads a Pi session archive payload even when archived_at is missing', async () => {
    const { calls } = createMockPool([
      {
        id: 'session-1',
        pi_session_archived_at: null,
        pi_session_archive_reason: null,
        pi_session_archive_payload: { version: 1, files: [] },
        pi_session_archive_restored_at: null,
      },
    ]);

    const archive = await getChatSessionPiSessionArchive('session-1');

    expect(archive?.pi_session_archive_payload).toEqual({
      version: 1,
      files: [],
    });
    expect(calls[0]?.sql).toContain('pi_session_archive_payload IS NOT NULL');
    expect(calls[0]?.sql).not.toContain('pi_session_archived_at IS NOT NULL');
  });

  it('soft deletes all account and web chat messages for a user transactionally', async () => {
    const { calls, clientCalls, client } = createMockPool([
      { id: 'account-1' },
      { id: 'account-2' },
    ]);

    await expect(resetUserMessages('user-1')).resolves.toEqual([
      'account-1',
      'account-2',
      'web:user-1',
    ]);

    expect(calls[0]?.sql).toContain('WHERE owner_id = $1');
    expect(clientCalls[0]?.sql).toBe('BEGIN');
    expect(clientCalls[1]?.sql).toContain('UPDATE messages');
    expect(clientCalls[1]?.sql).toContain('SET deleted_at');
    expect(clientCalls[1]?.sql).toContain('user_id = $2');
    expect(clientCalls[1]?.sql).toContain('account_id = ANY($3::text[])');
    expect(clientCalls[1]?.params?.[1]).toBe('user-1');
    expect(clientCalls[1]?.params?.[2]).toEqual([
      'account-1',
      'account-2',
      'web:user-1',
    ]);
    expect(clientCalls[2]?.sql).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });
});
