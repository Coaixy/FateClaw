import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastifyJwt from '@fastify/jwt';
import Fastify from 'fastify';
import Redis from 'ioredis';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type {
  ChatSessionSendResponseDto,
  SessionMessageListResponseDto,
} from '@fateclaw/contracts/chat';

const { broker, model } = vi.hoisted(() => ({
  broker: { host: undefined as Redis | undefined },
  model: vi.fn(async () => ({
    status: 'success' as const,
    result: 'Reply from the test model',
    usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 },
  })),
}));

vi.mock('#infrastructure/redis', () => ({ getRedis: () => broker.host }));
vi.mock('#runtime/local-runner', () => ({
  ensureLocalAgentRunning: async () => {},
  retainLocalAgent: () => 'test-worker-lease',
  releaseLocalAgent: async () => {},
}));
vi.mock('#modules/system/system-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#modules/system/system-config')>()),
  resolveUserLlmRuntime: async () => ({
    poolKey: 'official',
    source: 'official',
    billingMode: 'none',
    modelConfigId: 'test-model',
    providerKey: 'test-provider',
    piApi: 'openai-completions',
    displayName: 'Test model',
    secret: 'test-model-credential',
    secretSource: 'database',
    authMode: 'openai_api_key',
    baseUrl: null,
    model: 'test-model',
    contextWindowTokens: 4096,
    maxOutputTokens: 1024,
    thinkingLevel: 'off',
    inputTokenPricePerMillionCoins: 0,
    outputTokenPricePerMillionCoins: 0,
  }),
}));
vi.mock('../../../agent-runtime/src/request-boundary.js', () => ({
  executeContainerInput: model,
}));

import { closeDbPool, getDbPool, initDbPool } from '#infrastructure/db-pool';
import { runDatabaseMigrations } from '#infrastructure/migrations/runner';
import { createChatSession } from '#infrastructure/repositories/chat-repository';
import { chatSessionsRoutes } from '#interfaces/http/chat-sessions-routes';
import { runtimeIpcKey } from '#runtime/ipc-security';
import { _resetIpcWorkerForTests } from '#runtime/ipc-worker';
import { closeAgentDb } from '../../../agent-runtime/src/agent-db.js';
import { createInboxConsumer } from '../../../agent-runtime/src/inbox-consumer.js';
import { processInboxMessage } from '../../../agent-runtime/src/inbox-request.js';
import {
  connectRedis,
  disconnectRedis,
  getBlockingRedis,
  getRedis as getRuntimeRedis,
} from '../../../agent-runtime/src/redis.js';

const databaseUrl = process.env.FATECLAW_TEST_MIGRATIONS_DATABASE_URL;
const redisUrl = process.env.FATECLAW_TEST_REDIS_URL;

describe.skipIf(!databaseUrl || !redisUrl)('durable chat delivery', () => {
  it('accepts over HTTP and reconciles one stored reply without a WebSocket', async () => {
    const owner = `delivery-test-${randomUUID()}`;
    const accountId = `web:${owner}`;
    const sessionId = randomUUID();
    const database = `fateclaw_chat_test_${randomUUID().replaceAll('-', '')}`;
    const setup = new pg.Pool({ connectionString: databaseUrl });
    const spool = await mkdtemp(join(tmpdir(), 'fateclaw-chat-test-'));
    const app = Fastify();
    let consumer: ReturnType<typeof createInboxConsumer> | undefined;
    const requestState = {
      activeSessions: new Map(),
      pendingCancelRequests: new Map(),
      activeRequests: new Map(),
    };

    try {
      await setup.query(`CREATE DATABASE "${database}"`);
      const connection = new URL(databaseUrl!);
      connection.pathname = `/${database}`;
      const db = await initDbPool(connection.toString()).connect();
      try {
        await runDatabaseMigrations(db);
      } finally {
        db.release();
      }
      await getDbPool().query(
        'INSERT INTO users (id, created_at) VALUES ($1, now())',
        [owner],
      );
      await createChatSession({
        id: sessionId,
        accountId,
        userId: owner,
        title: '未设置标题',
      });

      broker.host = new Redis(redisUrl!, {
        lazyConnect: true,
        commandTimeout: 5000,
      });
      await broker.host.connect();
      vi.stubEnv('REDIS_URL', redisUrl);
      vi.stubEnv('DATABASE_URL', connection.toString());
      vi.stubEnv('FATECLAW_PI_SESSION_DIR', spool);
      vi.stubEnv('FATECLAW_IPC_KEY', runtimeIpcKey(accountId));
      await connectRedis();

      await app.register(fastifyJwt, {
        secret: 'synthetic-chat-delivery-secret',
      });
      app.decorateRequest('requireAuth', async function () {
        await this.jwtVerify();
      });
      await app.register(chatSessionsRoutes, { prefix: '/api/chat-sessions' });
      const headers = {
        authorization: `Bearer ${app.jwt.sign({ userId: owner })}`,
      };
      const url = `/api/chat-sessions/s/${sessionId}/messages`;
      const accepted = await app.inject({
        method: 'POST',
        url,
        headers,
        payload: { content: 'A test question' },
      });
      expect(accepted.statusCode, accepted.body).toBe(200);
      const response = accepted.json<ChatSessionSendResponseDto>();
      expect(response).toMatchObject({
        accepted: true,
        request_id: expect.any(String),
      });
      expect(model).not.toHaveBeenCalled();

      const blockingRedis = getBlockingRedis();
      consumer = createInboxConsumer({
        accountId,
        getConcurrency: async () => 1,
        pop: (member, normal, seconds) =>
          blockingRedis.brpop(member, normal, seconds),
        requeue: (queue, raw) => getRuntimeRedis().lpush(queue, raw),
        processMessage: (raw) =>
          processInboxMessage(accountId, raw, requestState),
      });
      void consumer.run();

      await vi.waitFor(
        async () => {
          const history = await app.inject({ method: 'GET', url, headers });
          expect(history.statusCode, history.body).toBe(200);
          const { messages, processing } =
            history.json<SessionMessageListResponseDto>();
          expect(processing).toBe(false);
          expect(messages).toHaveLength(2);
          expect(messages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                content: 'A test question',
                is_bot_message: false,
              }),
              expect.objectContaining({
                content: expect.stringContaining('Reply from the test model'),
                is_bot_message: true,
                metadata: expect.objectContaining({
                  request_id: response.request_id,
                }),
              }),
            ]),
          );
        },
        { timeout: 5000 },
      );
      expect(model).toHaveBeenCalledOnce();
      const { rows } = await getDbPool().query(
        `SELECT r.state, d.delivered
         FROM agent_requests r JOIN agent_result_deliveries d USING (request_id)
         WHERE r.request_id = $1`,
        [response.request_id],
      );
      expect(rows).toEqual([{ state: 'completed', delivered: true }]);
    } finally {
      await consumer?.stopAndDrain(2000);
      _resetIpcWorkerForTests();
      await app.close();
      await disconnectRedis();
      broker.host?.disconnect();
      broker.host = undefined;
      await closeAgentDb();
      await closeDbPool();
      await setup.query(`DROP DATABASE IF EXISTS "${database}"`);
      await setup.end();
      await rm(spool, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  }, 15000);
});
