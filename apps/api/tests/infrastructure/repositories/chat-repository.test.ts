import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

const { mockGetDbPool, mockGetRedis, mockLoggerWarn } = vi.hoisted(() => ({
  mockGetDbPool: vi.fn(),
  mockGetRedis: vi.fn(),
  mockLoggerWarn: vi.fn(),
}));

vi.mock('#infrastructure/db-pool', () => ({
  getDbPool: mockGetDbPool,
}));

vi.mock('#infrastructure/redis', () => ({
  getRedis: mockGetRedis,
}));

vi.mock('#infrastructure/logger', () => ({
  logger: {
    warn: mockLoggerWarn,
  },
}));

import {
  getArchivedChatSessionsByUserId,
  getChatSessionPiSessionArchive,
  getChatSessionsByUserId,
  getRecentMessages,
  resetUserMessages,
  restoreArchivedChatSession,
  storeMessage,
} from '#infrastructure/repositories/chat-repository';
import type { NewMessage } from '#shared/types';

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

  it('pages through shared timestamps without dropping or repeating messages', async () => {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(`CREATE TABLE messages (
        id TEXT, account_id TEXT, session_id TEXT,
        timestamp TEXT, deleted_at TEXT
      )`);
      const insert = database.prepare(
        'INSERT INTO messages VALUES (?, ?, ?, ?, ?)',
      );
      const timestamp = '2026-10-17T08:00:00.000Z';
      const tiedIds = Array.from(
        { length: 120 },
        (_, index) => `message-${String(index).padStart(3, '0')}`,
      );
      for (const id of tiedIds) {
        insert.run(id, 'account-1', 'session-1', timestamp, null);
      }
      insert.run(
        'older',
        'account-1',
        'session-1',
        '2026-10-17T07:00:00.000Z',
        null,
      );
      insert.run('other-owner', 'account-2', 'session-1', timestamp, null);
      insert.run('other-session', 'account-1', 'session-2', timestamp, null);
      insert.run('deleted', 'account-1', 'session-1', timestamp, timestamp);
      mockGetDbPool.mockReturnValue({
        async query(sql: string, params: SQLInputValue[]) {
          const bindings = Object.fromEntries(
            params.map((value, index) => [`$${index + 1}`, value]),
          );
          return { rows: database.prepare(sql).all(bindings) };
        },
      });

      const ids: string[] = [];
      let before: string | undefined;
      let beforeId: string | undefined;
      for (let pageIndex = 0; pageIndex < 4; pageIndex += 1) {
        const page = await getRecentMessages(
          'account-1',
          50,
          before,
          undefined,
          'session-1',
          beforeId,
        );
        ids.push(...page.map((row) => row.id));
        if (page.length === 0) break;
        before = page.at(-1)!.timestamp;
        beforeId = page.at(-1)!.id;
      }

      expect(ids).toHaveLength(121);
      expect(ids).toEqual([...tiedIds].reverse().concat('older'));
      const legacyPage = await getRecentMessages(
        'account-1',
        50,
        timestamp,
        undefined,
        'session-1',
      );
      expect(legacyPage.map((row) => row.id)).toEqual(['older']);
    } finally {
      database.close();
    }
  });

  it('discovers owned archived web sessions without a client and returns restored sessions to the active list', async () => {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(`CREATE TABLE chat_sessions (
        id TEXT, user_id TEXT, client_id TEXT, deleted_at TEXT, updated_at TEXT
      )`);
      const insert = database.prepare(
        'INSERT INTO chat_sessions VALUES (?, ?, ?, ?, ?)',
      );
      const earlier = '2026-10-28T00:00:00Z';
      const later = '2026-10-29T00:00:00Z';
      insert.run('unlinked', 'user-1', null, later, earlier);
      insert.run('linked', 'user-1', 'client-1', earlier, later);
      insert.run('active', 'user-1', null, null, earlier);
      insert.run('other-owner', 'user-2', null, later, later);
      insert.run('openapi:hidden', 'user-1', null, later, later);
      let databaseNow = '2026-10-29T01:00:00Z';
      mockGetDbPool.mockReturnValue({
        async query(sql: string, params: SQLInputValue[]) {
          const bindings = Object.fromEntries(
            params.map((value, index) => [`$${index + 1}`, value]),
          );
          return {
            rows: database
              .prepare(sql.replaceAll('NOW()', `'${databaseNow}'`))
              .all(bindings),
          };
        },
      });

      const archived = await getArchivedChatSessionsByUserId('user-1');
      expect(archived.map((session) => session.id)).toEqual([
        'unlinked',
        'linked',
      ]);
      expect(
        (await getChatSessionsByUserId('user-1')).map((session) => session.id),
      ).toEqual(['active']);
      expect(
        await restoreArchivedChatSession({
          userId: 'user-2',
          sessionId: 'unlinked',
        }),
      ).toBeUndefined();

      const restored = await restoreArchivedChatSession({
        userId: 'user-1',
        sessionId: 'unlinked',
      });
      expect(restored?.deleted_at).toBeNull();
      databaseNow = '2026-10-30T01:00:00Z';
      expect(
        await restoreArchivedChatSession({
          userId: 'user-1',
          sessionId: 'unlinked',
        }),
      ).toEqual(restored);
      expect(
        (await getArchivedChatSessionsByUserId('user-1')).map(
          (session) => session.id,
        ),
      ).toEqual(['linked']);
      expect(
        (await getChatSessionsByUserId('user-1')).map((session) => session.id),
      ).toEqual(['unlinked', 'active']);
    } finally {
      database.close();
    }
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
