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
import type { MemoryRequestScope } from '@fateclaw/contracts/memory';
import { closeDbPool, getDbPool, initDbPool } from '#infrastructure/db-pool';
import { crossConversationMemoryMigration } from '#infrastructure/migrations/versions/0102-cross-conversation-memory';
import { memoryReliabilityMigration } from '#infrastructure/migrations/versions/0103-memory-reliability';
import { getSessionMessagesWithToolContext } from '#infrastructure/repositories/chat-repository';
import {
  captureMemorySource,
  createMemoryAdmissionScope,
  withMemoryTransaction,
} from '#modules/memory/repository';
import { buildSessionBoardContexts } from '#modules/chat/active-board-context';
import { filterSessionContextMessages } from '#modules/chat/session-context-access';

vi.mock('#infrastructure/env', () => ({ readEnvFile: () => ({}) }));

const connectionString = process.env.FATECLAW_TEST_SESSION_CONTEXT_DATABASE_URL;
const schema = `session_context_test_${randomUUID().replace(/-/g, '')}`;
const accountId = 'web:owner';
const sessionId = 'shared-session';
let administrator: pg.Pool | undefined;
let schemaCreated = false;
let owner: MemoryRequestScope;
let a: MemoryRequestScope;
let b: MemoryRequestScope;

describe.skipIf(!connectionString)(
  'session resource actor provenance PostgreSQL integration',
  () => {
    beforeAll(async () => {
      const target = new URL(connectionString!);
      if (
        !['127.0.0.1', 'localhost'].includes(target.hostname) ||
        target.pathname !== '/memory_test'
      )
        throw new Error(
          'Session resource tests require an explicitly disposable local memory_test database',
        );
      administrator = new pg.Pool({
        connectionString,
        connectionTimeoutMillis: 5000,
      });
      await administrator.query(`CREATE SCHEMA ${schema}`);
      schemaCreated = true;
      target.searchParams.set('options', `-c search_path=${schema},public`);
      const db = initDbPool(target.toString());
      await db.query(`
      CREATE TABLE users(id text PRIMARY KEY,soul_content text NOT NULL DEFAULT '',soul_edit_enabled boolean NOT NULL DEFAULT true);
      CREATE TABLE accounts(id text PRIMARY KEY,owner_id text REFERENCES users(id),enabled boolean DEFAULT true,created_at timestamptz DEFAULT clock_timestamp(),soul_content text DEFAULT '');
      CREATE TABLE client_profiles(id text PRIMARY KEY,user_id text REFERENCES users(id),name text NOT NULL,deleted_at timestamptz);
      CREATE TABLE chat_sessions(id text PRIMARY KEY,account_id text NOT NULL,user_id text REFERENCES users(id),client_id text REFERENCES client_profiles(id),deleted_at timestamptz);
      CREATE TABLE messages(id text NOT NULL,account_id text NOT NULL,user_id text,session_id text REFERENCES chat_sessions(id),content text NOT NULL,timestamp timestamptz NOT NULL,is_from_me boolean,is_bot_message boolean,metadata jsonb,tool_context text,deleted_at timestamptz,PRIMARY KEY(id,account_id));
      CREATE TABLE runtime_config(id text PRIMARY KEY,revision integer DEFAULT 1,updated_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE agent_requests(request_id text PRIMARY KEY,account_id text,session_id text,owner_user_id text);
      INSERT INTO runtime_config(id)VALUES('default');
    `);
      const client = await db.connect();
      try {
        // The migration runner applies each version inside a transaction.
        await client.query('BEGIN');
        await crossConversationMemoryMigration.up(client);
        await memoryReliabilityMigration.up(client);
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      await db.query(
        'UPDATE runtime_config SET memory_policy=memory_policy||\'{"default_learning_enabled":false}\'::jsonb',
      );
    });
    afterAll(async () => {
      try {
        await closeDbPool();
      } finally {
        if (schemaCreated)
          await administrator?.query(`DROP SCHEMA ${schema} CASCADE`);
        await administrator?.end();
      }
    });

    async function scope(
      sender?: string,
      other = false,
    ): Promise<MemoryRequestScope> {
      return withMemoryTransaction((db) =>
        createMemoryAdmissionScope(db, {
          ownerUserId: other ? 'other' : 'owner',
          sessionId: other ? 'foreign-session' : sessionId,
          ...(sender
            ? {
                metadata: {
                  source_channel: 'wechat',
                  wechat_account_id: 'synthetic-bot',
                  sender_hash: sender,
                },
              }
            : {}),
        }),
      );
    }
    async function request(
      id: string,
      identity: MemoryRequestScope,
      other = false,
    ) {
      await getDbPool().query(
        'INSERT INTO agent_requests(request_id,account_id,session_id,owner_user_id,memory_scope) VALUES($1,$2,$3,$4,$5)',
        [
          id,
          other ? 'web:other' : accountId,
          other ? 'foreign-session' : sessionId,
          identity.ownerUserId,
          JSON.stringify(identity),
        ],
      );
    }
    async function message(
      id: string,
      text: string,
      metadata: Record<string, unknown> = {},
      other = false,
      board = true,
    ) {
      await getDbPool().query(
        'INSERT INTO messages(id,account_id,user_id,session_id,content,timestamp,is_from_me,is_bot_message,metadata,tool_context) VALUES($1,$2,$3,$4,$5,clock_timestamp(),false,false,$6,$7)',
        [
          id,
          other ? 'web:other' : accountId,
          other ? 'other' : 'owner',
          other ? 'foreign-session' : sessionId,
          `Synthetic message ${id}`,
          JSON.stringify(metadata),
          board
            ? JSON.stringify([
                { skill: 'bazi-paipan', output: text, artifactTitle: id },
              ])
            : null,
        ],
      );
    }
    async function source(id: string, identity: MemoryRequestScope) {
      return withMemoryTransaction(async (db) => {
        const captured = await captureMemorySource(db, {
          scope: identity,
          requestId: `source-${id}`,
          messageId: id,
          accountId,
          sessionId,
          role: 'user',
          content: `Synthetic message ${id}`,
          observedAt: new Date().toISOString(),
          eventType: 'user_message_committed',
        });
        if (!captured) throw new Error('Synthetic source was not captured');
        return captured;
      });
    }
    beforeEach(async () => {
      await getDbPool().query(
        `TRUNCATE ${schema}.users,${schema}.agent_requests CASCADE`,
      );
      await getDbPool().query(
        "INSERT INTO users(id)VALUES('owner'),('other'); INSERT INTO chat_sessions(id,account_id,user_id)VALUES('shared-session','web:owner','owner'),('foreign-session','web:other','other')",
      );
      owner = await scope();
      const oldA = await scope('sender-a');
      b = await scope('sender-b');
      await message('stale-binding-a', 'STALE_BINDING_BOARD');
      await source('stale-binding-a', oldA);
      await getDbPool().query(
        'UPDATE memory_scopes SET binding_revision=binding_revision+1 WHERE id=$1',
        [oldA.scopeId],
      );
      a = await scope('sender-a');
      const foreign = await scope(undefined, true);
      await request('request-owner', owner);
      await request('request-a', a);
      await request('request-b', b);
      await request('request-foreign', foreign, true);
      await message('owner-board', 'OWNER_PRIVATE_BOARD', {
        request_id: 'request-owner',
      });
      await message('a-request-board', 'A_REQUEST_BOARD', {
        request_id: 'request-a',
      });
      await message('a-source-board', 'A_SOURCE_BOARD');
      await source('a-source-board', a);
      await message('b-board', 'B_PRIVATE_BOARD', { request_id: 'request-b' });
      await message('legacy-board', 'LEGACY_UNKNOWN_BOARD');
      await message('metadata-only-a', 'LEGACY_SENDER_METADATA_BOARD', {
        source_channel: 'wechat',
        wechat_account_id: 'synthetic-bot',
        sender_hash: 'sender-a',
      });
      await message('conflicting-board', 'CONFLICTING_IDENTITY_BOARD', {
        request_id: 'request-b',
      });
      await source('conflicting-board', a);
      await message('wrong-audience-board', 'WRONG_AUDIENCE_BOARD');
      const wrong = await source('wrong-audience-board', a);
      await getDbPool().query(
        "UPDATE memory_sources SET identity_snapshot=jsonb_set(identity_snapshot,'{contextAudience}','\"\"') WHERE id=$1",
        [wrong.id],
      );
      await message('partial-source-board', 'PARTIAL_IDENTITY_BOARD', {
        request_id: 'request-a',
      });
      const partial = await source('partial-source-board', a);
      await getDbPool().query(
        "UPDATE memory_sources SET identity_snapshot=identity_snapshot-'contextAudience' WHERE id=$1",
        [partial.id],
      );
      await message('foreign-request-board', 'FOREIGN_REQUEST_BOARD', {
        request_id: 'request-foreign',
      });
      await message(
        'foreign-board',
        'FOREIGN_USER_BOARD',
        { request_id: 'request-foreign' },
        true,
      );
      await message(
        'ordinary-a',
        '',
        { request_id: 'request-a' },
        false,
        false,
      );
      await message(
        'ordinary-b',
        '',
        { request_id: 'request-b' },
        false,
        false,
      );
    });

    const boards = () =>
      getSessionMessagesWithToolContext(accountId, sessionId);
    it('excludes owner and other actors boards that the previous whole-session builder included', async () => {
      const all = await boards();
      const previous = JSON.stringify(buildSessionBoardContexts(all));
      expect(previous).toContain('OWNER_PRIVATE_BOARD');
      expect(previous).toContain('B_PRIVATE_BOARD');
      const before = JSON.stringify(all);
      const allowed = await filterSessionContextMessages({
        scope: a,
        accountId,
        sessionId,
        messages: all,
      });
      expect(allowed.map((row) => row.id).sort()).toEqual([
        'a-request-board',
        'a-source-board',
      ]);
      expect(JSON.stringify(buildSessionBoardContexts(allowed))).toContain(
        'A_REQUEST_BOARD',
      );
      expect(JSON.stringify(buildSessionBoardContexts(allowed))).not.toContain(
        'OWNER_PRIVATE_BOARD',
      );
      expect(JSON.stringify(buildSessionBoardContexts(allowed))).not.toContain(
        'B_PRIVATE_BOARD',
      );
      expect(JSON.stringify(all)).toBe(before);
      expect(allowed[0]).toBe(all.find((row) => row.id === allowed[0].id));
      expect(
        (
          await filterSessionContextMessages({
            scope: b,
            accountId,
            sessionId,
            messages: all,
          })
        ).map((row) => row.id),
      ).toEqual(['b-board']);
    });

    it('rejects an excluded selected board instead of silently falling back to another board', async () => {
      const all = await boards();
      expect(
        buildSessionBoardContexts(all, {
          selectedBoardMessageId: 'owner-board',
        }).find((row) => row.isCurrent)?.promptText,
      ).toContain('OWNER_PRIVATE_BOARD');
      await expect(
        filterSessionContextMessages({
          scope: a,
          accountId,
          sessionId,
          messages: all,
          selectedBoardMessageId: 'owner-board',
        }),
      ).rejects.toMatchObject({ statusCode: 403, code: 'MEMORY.BOARD_DENIED' });
      const allowed = await filterSessionContextMessages({
        scope: a,
        accountId,
        sessionId,
        messages: all,
        selectedBoardMessageId: 'a-source-board',
      });
      expect(
        buildSessionBoardContexts(allowed, {
          selectedBoardMessageId: 'a-source-board',
        }).find((row) => row.isCurrent)?.sourceMessageId,
      ).toBe('a-source-board');
    });

    it('preserves the explicitly supplied current pasted board and does not change frozen source identities', async () => {
      const stored = await getDbPool().query(
        'SELECT id,identity_snapshot FROM memory_sources ORDER BY id',
      );
      const allowed = await filterSessionContextMessages({
        scope: a,
        accountId,
        sessionId,
        messages: await boards(),
      });
      const result = buildSessionBoardContexts(allowed, {
        currentPastedBoard: {
          sourceMessageId: 'current-message',
          pastedBoard: {
            category: '八字',
            content: 'CURRENT_EXPLICIT_PASTED_BOARD',
            question: '当前问题',
          },
          createdAt: '2030-01-01T00:00:00Z',
        },
      });
      expect(
        result.find((row) => row.sourceMessageId === 'current-message'),
      ).toMatchObject({
        promptText: 'CURRENT_EXPLICIT_PASTED_BOARD',
        isCurrent: true,
      });
      expect(
        (
          await getDbPool().query(
            'SELECT id,identity_snapshot FROM memory_sources ORDER BY id',
          )
        ).rows,
      ).toEqual(stored.rows);
    });

    it('allows owner-visible legacy resources only to the owner or explicitly shared owner binding', async () => {
      const all = await boards();
      const own = await filterSessionContextMessages({
        scope: owner,
        accountId,
        sessionId,
        messages: all,
      });
      expect(own).toEqual(all);
      expect(JSON.stringify(own)).toContain('LEGACY_UNKNOWN_BOARD');
      await getDbPool().query(
        "UPDATE memory_scopes SET bound_subject_id='self:owner',share_subject_memory=true,binding_revision=binding_revision+1 WHERE id=$1",
        [a.scopeId],
      );
      const verified = await scope('sender-a');
      expect(
        await filterSessionContextMessages({
          scope: verified,
          accountId,
          sessionId,
          messages: all,
        }),
      ).toEqual(all);
      await expect(
        filterSessionContextMessages({
          scope: a,
          accountId,
          sessionId,
          messages: all,
        }),
      ).rejects.toMatchObject({ code: 'MEMORY.BINDING_CHANGED' });
    });

    it('also filters ordinary stored messages by the same frozen provenance for restoration callers', async () => {
      const rows = (
        await getDbPool().query<{ id: string; content: string }>(
          "SELECT id,content FROM messages WHERE id IN ('ordinary-a','ordinary-b') ORDER BY id",
        )
      ).rows;
      const result = await filterSessionContextMessages({
        scope: a,
        accountId,
        sessionId,
        messages: rows,
      });
      expect(result.map((row) => row.id)).toEqual(['ordinary-a']);
      expect(result[0].content).toBe(rows[0].content);
    });

    it('rejects foreign session and account records even for an owner-visible request', async () => {
      const foreignRows = (
        await getDbPool().query<{
          id: string;
          account_id: string;
          session_id: string;
          user_id: string;
          tool_context: string;
        }>(
          "SELECT id,account_id,session_id,user_id,tool_context FROM messages WHERE id='foreign-board'",
        )
      ).rows;
      expect(
        await filterSessionContextMessages({
          scope: owner,
          accountId,
          sessionId,
          messages: foreignRows,
        }),
      ).toEqual([]);
      expect(
        await filterSessionContextMessages({
          scope: owner,
          accountId: 'web:other',
          sessionId: 'foreign-session',
          messages: foreignRows,
        }),
      ).toEqual([]);
    });
  },
);
