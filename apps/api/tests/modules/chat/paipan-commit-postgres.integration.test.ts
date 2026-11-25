import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const { redisGet, redisSet, redisDel } = vi.hoisted(() => ({
  redisGet: vi.fn<(key: string) => Promise<string | null>>(),
  redisSet: vi.fn<(key: string, record: string) => Promise<string>>(),
  redisDel: vi.fn<(key: string) => Promise<number>>(),
}));

vi.mock('#infrastructure/redis', () => ({
  getRedis: () => ({ get: redisGet, set: redisSet, del: redisDel }),
}));
vi.mock('#infrastructure/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('#modules/chat/paipan-runtime', () => ({
  DirectPaipanError: class extends Error {},
  executeDirectPaipan: async () => ({
    skill: { dir: 'iching-paipan' },
    requestSummary: 'Test board request',
    sessionTitle: 'Test chart',
    skillContextEntry: { skill: 'iching-paipan', output: 'Test chart details' },
  }),
}));

import { closeDbPool, getDbPool, initDbPool } from '#infrastructure/db-pool';
import { runDatabaseMigrations } from '#infrastructure/migrations/runner';
import { createChatSession } from '#infrastructure/repositories/chat-repository';
import {
  commitDirectPaipanForOwnedUser,
  previewDirectPaipanForOwnedUser,
} from '#modules/chat/paipan-service';

// Only an explicitly disposable server with CREATE DATABASE permission is used.
const databaseUrl = process.env.FATECLAW_TEST_MIGRATIONS_DATABASE_URL;

describe.skipIf(!databaseUrl)('direct paipan commit with PostgreSQL', () => {
  const databaseName = `fateclaw_paipan_test_${randomUUID().replaceAll('-', '')}`;
  const previews = new Map<string, string>();
  let admin: pg.Pool | undefined;

  beforeAll(async () => {
    admin = new pg.Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 5_000,
    });
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(databaseUrl!);
    url.pathname = `/${databaseName}`;
    const db = await initDbPool(url.toString()).connect();
    try {
      await runDatabaseMigrations(db);
    } finally {
      db.release();
    }
  });

  afterAll(async () => {
    await closeDbPool();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    previews.clear();
    vi.resetAllMocks();
    redisGet.mockImplementation(async (key) => previews.get(key) ?? null);
    redisSet.mockImplementation(async (key, record) => {
      previews.set(key, record);
      return 'OK';
    });
    redisDel.mockImplementation(async (key) => Number(previews.delete(key)));
    await getDbPool().query('TRUNCATE users CASCADE');
    await getDbPool().query(
      "INSERT INTO users (id, created_at) VALUES ('owner', now()), ('other-user', now())",
    );
  });

  async function previewRequest(userId?: string) {
    const preview = await previewDirectPaipanForOwnedUser({
      userId,
      skill: 'iching-paipan',
      input: {},
    });
    if (!preview.ok) throw new Error(preview.error);
    return {
      target: 'new_session_from_preview',
      previewId: preview.data.previewId,
    } as const;
  }

  async function expectRowCounts(
    sessions: number,
    messages: number,
    receipts: number,
  ) {
    const { rows } = await getDbPool().query(`
      SELECT (SELECT count(*)::int FROM chat_sessions) AS sessions,
             (SELECT count(*)::int FROM messages) AS messages,
             (SELECT count(*)::int FROM direct_paipan_commits) AS receipts
    `);
    expect(rows).toEqual([{ sessions, messages, receipts }]);
  }

  async function rejectBoardResult() {
    await getDbPool()
      .query(`ALTER TABLE messages ADD CONSTRAINT test_no_board_result
      CHECK (metadata->>'kind' <> 'board_result')`);
  }

  async function restoreBoardResult() {
    await getDbPool().query(
      'ALTER TABLE messages DROP CONSTRAINT test_no_board_result',
    );
  }

  it('commits a preview exactly once when two requests have both read Redis', async () => {
    const request = await previewRequest();
    const bothRead = Promise.withResolvers<void>();
    let reads = 0;
    const readConcurrently = async (key: string) => {
      const preview = previews.get(key) ?? null;
      if (++reads === 2) bothRead.resolve();
      await bothRead.promise;
      return preview;
    };
    redisGet
      .mockImplementationOnce(readConcurrently)
      .mockImplementationOnce(readConcurrently);

    const [first, duplicate] = await Promise.all([
      commitDirectPaipanForOwnedUser('owner', request),
      commitDirectPaipanForOwnedUser('owner', request),
    ]);
    expect(first.ok).toBe(true);
    expect(duplicate).toEqual(first);
    expect(previews.size).toBe(0);
    await expectRowCounts(1, 2, 1);

    redisGet.mockRejectedValue(new Error('Redis unavailable'));
    await expect(
      commitDirectPaipanForOwnedUser('owner', request),
    ).resolves.toEqual(first);
    await expect(
      commitDirectPaipanForOwnedUser('other-user', request),
    ).resolves.toMatchObject({
      ok: false,
      statusCode: 403,
    });
  });

  it('rolls back the receipt, session and first message when the second message fails', async () => {
    const request = await previewRequest('owner');
    await rejectBoardResult();
    try {
      await expect(
        commitDirectPaipanForOwnedUser('owner', request),
      ).resolves.toMatchObject({
        ok: false,
        statusCode: 500,
      });
      await expectRowCounts(0, 0, 0);
      expect(previews.size).toBe(1);
    } finally {
      await restoreBoardResult();
    }

    await expect(
      commitDirectPaipanForOwnedUser('owner', request),
    ).resolves.toMatchObject({ ok: true });
    await expectRowCounts(1, 2, 1);
  });

  it('keeps a guest preview bound to its first submitter when Redis cleanup fails', async () => {
    const request = await previewRequest();
    redisDel.mockRejectedValue(new Error('Redis unavailable'));
    const saved = await commitDirectPaipanForOwnedUser('owner', request);
    if (!saved.ok) throw new Error(saved.error);
    expect(previews.size).toBe(1);

    await getDbPool().query(
      'UPDATE chat_sessions SET deleted_at=now() WHERE id=$1',
      [saved.data.session.id],
    );
    await expect(
      commitDirectPaipanForOwnedUser('owner', request),
    ).resolves.toMatchObject({ ok: false, statusCode: 410 });
    await expect(
      commitDirectPaipanForOwnedUser('other-user', request),
    ).resolves.toMatchObject({ ok: false, statusCode: 403 });
    await expectRowCounts(1, 2, 1);

    // Deleting the account removes its data but must not reactivate a cached guest preview.
    const db = await getDbPool().connect();
    try {
      await db.query('BEGIN');
      await db.query("DELETE FROM messages WHERE user_id='owner'");
      await db.query("DELETE FROM chat_sessions WHERE user_id='owner'");
      await db.query("DELETE FROM users WHERE id='owner'");
      await db.query('COMMIT');
    } finally {
      db.release();
    }
    await expect(
      commitDirectPaipanForOwnedUser('other-user', request),
    ).resolves.toMatchObject({ ok: false, statusCode: 410 });
    await expectRowCounts(0, 0, 1);
  });

  it('rolls back a partial current-session write and preserves the original session', async () => {
    const sessionId = 'owned-session';
    await createChatSession({
      id: sessionId,
      userId: 'owner',
      accountId: 'web:owner',
      title: 'Existing chat',
    });
    const request = {
      target: 'current_session',
      sessionId,
      skill: 'iching-paipan',
      input: {},
    } as const;

    await rejectBoardResult();
    try {
      await expect(
        commitDirectPaipanForOwnedUser('owner', request),
      ).resolves.toMatchObject({ ok: false, statusCode: 500 });
      await expectRowCounts(1, 0, 0);
    } finally {
      await restoreBoardResult();
    }

    await expect(
      commitDirectPaipanForOwnedUser('other-user', request),
    ).resolves.toMatchObject({ ok: false, statusCode: 403 });
    await expect(
      commitDirectPaipanForOwnedUser('owner', request),
    ).resolves.toMatchObject({
      ok: true,
      data: { session: { id: sessionId } },
    });
    await expectRowCounts(1, 2, 0);
  });
});
