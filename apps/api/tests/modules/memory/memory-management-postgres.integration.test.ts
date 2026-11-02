import { randomUUID } from 'node:crypto';
import pg from 'pg';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { initDbPool, getDbPool, closeDbPool } from '#infrastructure/db-pool';
import { durableAgentRequestsMigration } from '#infrastructure/migrations/versions/0076-durable-agent-requests';
import { crossConversationMemoryMigration } from '#infrastructure/migrations/versions/0102-cross-conversation-memory';
import { memoryReliabilityMigration } from '#infrastructure/migrations/versions/0103-memory-reliability';
import { admitAgentRequest } from '#infrastructure/repositories/agent-requests-repository';
import type { AiChatSubmission } from '#runtime/request-types';
import type { LlmRuntimeSnapshot } from '@fateclaw/contracts/agent';
import { DEFAULT_MEMORY_RUNTIME_POLICY } from '@fateclaw/contracts/memory';
import {
  getCurrentMemorySource,
  insertMemoryItem,
  queueMemoryJob,
  withMemoryTransaction,
} from '#modules/memory/repository';
import { getMemorySettings } from '#modules/memory/service';
import {
  listMemorySessions,
  updateMemorySessionSettings,
} from '#modules/memory/session-settings';
import { memoryRoutes } from '#interfaces/http/memory-routes';

vi.mock('#infrastructure/env', () => ({ readEnvFile: () => ({}) }));
const connectionString = process.env.FATECLAW_TEST_TEXT_MEMORY_DATABASE_URL;
const schema = `memory_manage_test_${randomUUID().replace(/-/g, '')}`;
let administrator: pg.Pool;
let app: FastifyInstance;
const runtime: LlmRuntimeSnapshot = {
  source: 'official',
  billingMode: 'none',
  modelConfigId: 'synthetic',
  piApi: 'openai-completions',
  model: 'synthetic',
  apiKey: 'synthetic-management-test-value',
  authMode: 'openai_api_key',
  providerKey: 'synthetic',
};

describe.skipIf(!connectionString)(
  'memory management PostgreSQL and private HTTP integration',
  () => {
    beforeAll(async () => {
      const target = new URL(connectionString!);
      if (
        !['127.0.0.1', 'localhost'].includes(target.hostname) ||
        target.pathname !== '/memory_test'
      )
        throw new Error(
          'Management integration requires the disposable local memory_test database',
        );
      administrator = new pg.Pool({ connectionString });
      await administrator.query(`CREATE SCHEMA ${schema}`);
      target.searchParams.set('options', `-c search_path=${schema},public`);
      const db = initDbPool(target.toString());
      expect(
        (await db.query('SELECT current_schema() AS name')).rows[0].name,
      ).toBe(schema);
      await db.query(`
      CREATE TABLE users(id text PRIMARY KEY,soul_content text NOT NULL DEFAULT '',soul_edit_enabled boolean NOT NULL DEFAULT true,created_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE accounts(id text PRIMARY KEY,owner_id text REFERENCES users(id),soul_content text DEFAULT '',enabled boolean DEFAULT true,created_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE client_profiles(id text PRIMARY KEY,user_id text REFERENCES users(id),name text NOT NULL,deleted_at timestamptz);
      CREATE TABLE chat_sessions(id text PRIMARY KEY,account_id text NOT NULL,user_id text REFERENCES users(id),client_id text REFERENCES client_profiles(id),title text NOT NULL DEFAULT '',deleted_at timestamptz,model_pool_key text DEFAULT 'official',updated_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE messages(id text NOT NULL,account_id text NOT NULL,user_id text,sender text,sender_name text,content text NOT NULL,timestamp timestamptz NOT NULL,is_from_me boolean,is_bot_message boolean,tool_context jsonb,session_id text REFERENCES chat_sessions(id),metadata jsonb,deleted_at timestamptz,PRIMARY KEY(id,account_id));
      CREATE TABLE runtime_config(id text PRIMARY KEY,revision integer NOT NULL DEFAULT 1,updated_at timestamptz DEFAULT clock_timestamp());
      INSERT INTO runtime_config(id) VALUES('default');
      CREATE TABLE config_audit_logs(id text PRIMARY KEY,actor_user_id text,action text,target_type text,target_key text,before_json jsonb,after_json jsonb);
    `);
      const client = await db.connect();
      try {
        await durableAgentRequestsMigration.up(client);
        // The migration runner applies each version inside a transaction.
        await client.query('BEGIN');
        await crossConversationMemoryMigration.up(client);
        await memoryReliabilityMigration.up(client);
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      app = Fastify({ logger: false });
      await app.register(fastifyJwt, {
        secret: 'synthetic-memory-management-jwt-secret',
      });
      app.decorateRequest('requireAuth', async function () {
        await this.jwtVerify();
      });
      await app.register(memoryRoutes, { prefix: '/api/memory' });
      await app.ready();
    }, 30_000);

    beforeEach(async () => {
      await getDbPool().query(
        `TRUNCATE ${schema}.users,${schema}.agent_requests,${schema}.agent_result_deliveries,${schema}.memory_daily_budgets CASCADE`,
      );
      await getDbPool().query(
        "INSERT INTO users(id)VALUES('owner'),('other'); INSERT INTO client_profiles(id,user_id,name)VALUES('client','owner','合成命主'); INSERT INTO chat_sessions(id,account_id,user_id,title)VALUES('session-a','web:owner','owner','备考安排'),('session-b','web:owner','owner','饮食记录'),('session-wechat','web:owner','owner','微信讨论'),('session-other','web:other','other','其他用户的会话')",
      );
      await getDbPool().query(
        "UPDATE runtime_config SET memory_policy=$1::jsonb WHERE id='default'",
        [JSON.stringify(DEFAULT_MEMORY_RUNTIME_POLICY)],
      );
    });

    afterAll(async () => {
      if (app) await app.close();
      await closeDbPool();
      if (administrator) {
        await administrator.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await administrator.end();
      }
    });

    const headers = (owner = 'owner') => ({
      authorization: `Bearer ${app.jwt.sign({ userId: owner, authTokenVersion: 1 })}`,
    });

    async function turn(
      content: string,
      owner = 'owner',
      sessionId = owner === 'owner' ? 'session-a' : 'session-other',
      metadata?: Record<string, unknown>,
    ) {
      const requestId = randomUUID();
      const messageId = randomUUID();
      const input: AiChatSubmission = {
        accountId: `web:${owner}`,
        sessionId,
        userMessageId: messageId,
        userMessage: content,
        history: [],
        messageToPersist: {
          id: messageId,
          account_id: `web:${owner}`,
          user_id: owner,
          sender: owner,
          sender_name: '合成用户',
          content,
          timestamp: new Date().toISOString(),
          session_id: sessionId,
          is_from_me: false,
          is_bot_message: false,
          metadata,
        },
      };
      await admitAgentRequest({
        input,
        requestId,
        ownerUserId: owner,
        runtime,
        deadlineAt: Date.now() + 60_000,
      });
      const sourceId = (
        await getDbPool().query(
          'SELECT id FROM memory_sources WHERE message_id=$1',
          [messageId],
        )
      ).rows[0].id as string;
      return { scope: input.memoryScope!, sourceId, requestId, messageId };
    }

    it('changes only the owner session switch using CAS and cancels automatic work while retaining explicit imports and history', async () => {
      const first = await turn('我喜欢简洁回答。');
      const second = await turn('我喜欢长回答。', 'owner', 'session-b');
      const originalSource = (await getCurrentMemorySource(first.sourceId))!;
      const retainedItem = await withMemoryTransaction((db) =>
        insertMemoryItem(db, {
          scope: first.scope,
          content: '我喜欢简洁回答。',
          kind: 'preference',
          origin: 'automatic',
          source: originalSource,
          quote: '我喜欢简洁回答。',
        }),
      );
      const settings = await getMemorySettings('owner');
      const grants = await withMemoryTransaction(async (db) => [
        await queueMemoryJob(db, {
          scope: first.scope,
          kind: 'extract',
          eventType: 'explicit_backfill_grant',
          key: 'explicit-grant',
          sourceId: first.sourceId,
          sourceRevision: 1,
        }),
        await queueMemoryJob(db, {
          scope: first.scope,
          kind: 'extract',
          eventType: 'user_message_committed',
          key: 'explicit-capture',
          sourceId: first.sourceId,
          sourceRevision: 1,
          payload: { backfillJobId: 'backfill' },
        }),
      ]);
      await getDbPool().query(
        "UPDATE memory_jobs SET state='running',lease_token='live-lease',lease_until=clock_timestamp()+interval '1 minute' WHERE request_id=$1 AND kind='extract'",
        [first.requestId],
      );
      const changed = await Promise.allSettled([
        updateMemorySessionSettings('owner', 'session-a', {
          learning_enabled: false,
          revision: 1,
        }),
        updateMemorySessionSettings('owner', 'session-a', {
          learning_enabled: false,
          revision: 1,
        }),
      ]);
      expect(
        changed.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      const rejected = changed.find((result) => result.status === 'rejected');
      expect(rejected?.status === 'rejected' && rejected.reason.code).toBe(
        'MEMORY.SESSION_CONFLICT',
      );
      expect(
        await updateMemorySessionSettings('owner', 'session-a', {
          learning_enabled: false,
          revision: 2,
        }),
      ).toMatchObject({ learning_enabled: false, revision: 2 });
      expect(
        (
          await getDbPool().query(
            "SELECT state,lease_token FROM memory_jobs WHERE request_id=$1 AND kind='extract'",
            [first.requestId],
          )
        ).rows,
      ).toEqual([{ state: 'cancelled', lease_token: null }]);
      expect(
        (
          await getDbPool().query(
            'SELECT state FROM memory_jobs WHERE request_id=$1',
            [second.requestId],
          )
        ).rows.every((row) => row.state === 'pending'),
      ).toBe(true);
      expect(
        (
          await getDbPool().query(
            'SELECT state FROM memory_jobs WHERE id=ANY($1::text[])',
            [grants],
          )
        ).rows,
      ).toEqual([{ state: 'pending' }, { state: 'pending' }]);
      expect(await getMemorySettings('owner')).toEqual(settings);
      expect(
        (
          await getDbPool().query(
            'SELECT content,status FROM memory_items WHERE id=$1',
            [retainedItem.id],
          )
        ).rows,
      ).toEqual([{ content: '我喜欢简洁回答。', status: 'active' }]);
      expect(
        (await getDbPool().query('SELECT count(*)::int AS count FROM messages'))
          .rows[0].count,
      ).toBe(2);
      expect(
        await updateMemorySessionSettings('owner', 'session-a', {
          learning_enabled: true,
          revision: 2,
        }),
      ).toMatchObject({ learning_enabled: true, revision: 3 });
      await expect(
        updateMemorySessionSettings('other', 'session-a', {
          learning_enabled: false,
          revision: 3,
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('pages owner sessions with full timestamp precision and omits archived and Open API sessions', async () => {
      await getDbPool().query(
        "UPDATE chat_sessions SET deleted_at=clock_timestamp() WHERE user_id='owner'; INSERT INTO chat_sessions(id,account_id,user_id,title,updated_at)VALUES('a-latest','web:owner','owner','较新会话','2026-10-31 03:40:55.123900+00'),('z-earlier','web:owner','owner','较早会话','2026-10-31 03:40:55.123705+00'),('openapi:private','web:owner','owner','业务会话',clock_timestamp())",
      );
      const first = await listMemorySessions('owner', { limit: 1 });
      expect(first.sessions.map((row) => row.id)).toEqual(['a-latest']);
      expect(
        JSON.parse(Buffer.from(first.next_cursor!, 'base64url').toString()).at,
      ).toBe('2026-10-31 03:40:55.1239+00');
      const second = await listMemorySessions('owner', {
        limit: 1,
        cursor: first.next_cursor!,
      });
      expect(second.sessions.map((row) => row.id)).toEqual(['z-earlier']);
      expect(second.next_cursor).toBeNull();
      expect(
        (await listMemorySessions('other')).sessions.map((row) => row.id),
      ).toEqual(['session-other']);
    });

    it('keeps the existing private auth hook and rejects unknown request fields before changing owned sessions', async () => {
      expect((await app.inject('/api/memory/sessions')).statusCode).toBe(401);
      for (const request of [
        {
          method: 'GET' as const,
          url: '/api/memory/sessions?owner_user_id=other',
        },
        {
          method: 'PATCH' as const,
          url: '/api/memory/sessions/session-a',
          payload: {
            learning_enabled: false,
            revision: 1,
            owner_user_id: 'other',
          },
        },
        {
          method: 'PATCH' as const,
          url: '/api/memory/sessions/session-a',
          payload: { learning_enabled: 'false', revision: 1 },
        },
      ])
        expect(
          (await app.inject({ ...request, headers: headers() })).statusCode,
        ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: '/api/memory/sessions/session-other',
            headers: headers(),
            payload: { learning_enabled: false, revision: 1 },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: '/api/memory/sessions/session-a',
            headers: headers(),
            payload: { learning_enabled: false, revision: 1 },
          })
        ).json(),
      ).toMatchObject({
        id: 'session-a',
        learning_enabled: false,
        revision: 2,
      });
    });
  },
);
