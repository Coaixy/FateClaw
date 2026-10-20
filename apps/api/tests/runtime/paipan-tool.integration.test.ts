import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { deriveRuntimeIpcKey } from '@fateclaw/contracts/runtime-ipc';
import {
  paipanRequestQueue,
  type PaipanIpcRequest,
} from '@fateclaw/contracts/agent/paipan';
import { visualizationRequestQueue } from '@fateclaw/contracts/agent/visualization';

const { broker, mockWarn } = vi.hoisted(() => ({
  broker: { host: null as Redis | null, runtime: null as Redis | null },
  mockWarn: vi.fn(),
}));
vi.mock('#infrastructure/config', () => ({
  JWT_SECRET: 'synthetic-paipan-root',
}));
vi.mock('#infrastructure/logger', () => ({
  logger: { warn: mockWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('#infrastructure/redis', () => ({ getRedis: () => broker.host! }));
vi.mock('../../../agent-runtime/src/redis', () => ({
  getRedis: () => broker.runtime!,
}));
vi.mock('#infrastructure/db', async () => ({
  ...(await import('#infrastructure/repositories/skills-repository')),
  ...(await import('#infrastructure/repositories/client-profiles-repository')),
  getChatSession: vi.fn(),
  getUserById: vi.fn(),
}));

import { closeDbPool, getDbPool, initDbPool } from '#infrastructure/db-pool';
import { getSessionMessagesWithToolContext } from '#infrastructure/repositories/chat-repository';
import { InactiveConversationRequestError } from '#infrastructure/repositories/conversation-tool-repository';
import { buildSessionBoardContexts } from '#modules/chat/active-board-context';
import { listPaipanRegistry } from '#modules/chat/paipan-registry';
import { executeConversationPaipan } from '#modules/chat/conversation-paipan-service';
import { processPaipanToolPayload } from '#runtime/paipan-tool-handler';
import { processVisualizationToolPayload } from '#runtime/visualization-tool-handler';
import { decodeRuntimeIpc } from '#runtime/ipc-security';
import { createPaipanCaller } from '../../../agent-runtime/src/paipan-client';
import { createHostToolCaller } from '../../../agent-runtime/src/host-tool-client';
import { createPiCustomTools } from '../../../agent-runtime/src/pi-runtime/tools';
import { createRequestScope } from '../../../agent-runtime/src/request-scope';

// Explicit disposable stores only; never use DATABASE_URL or REDIS_URL here.
const databaseUrl = process.env.FATECLAW_TEST_PAIPAN_DATABASE_URL;
const redisUrl = process.env.FATECLAW_TEST_PAIPAN_REDIS_URL;
const accountId = 'web:synthetic-paipan-user';
const requestId = 'synthetic-paipan-request';
const executionId = 'synthetic-paipan-execution';
const baziInput = {
  solarDate: '1990-05-15',
  hour: 10,
  minute: 30,
  gender: '男',
  include: ['bazi'],
};

function request(
  input: Record<string, unknown> = baziInput,
  skill = 'bazi-paipan',
  toolCallId = 'create-1',
): PaipanIpcRequest {
  return {
    rpcId: randomUUID(),
    requestId,
    executionId,
    operation: { mode: 'create', skill, input, toolCallId },
  };
}

describe.skipIf(!databaseUrl || !redisUrl)(
  'conversation paipan with PostgreSQL and Redis',
  () => {
    let consumer: Redis;
    let serve: Promise<void>;
    let stopped = false;

    beforeAll(async () => {
      initDbPool(databaseUrl!);
      await getDbPool().query(`
      CREATE TABLE chat_sessions (id text PRIMARY KEY, account_id text, user_id text, client_id text, deleted_at timestamptz, updated_at timestamptz DEFAULT now());
      CREATE TABLE agent_requests (request_id text PRIMARY KEY, execution_id text, account_id text, session_id text REFERENCES chat_sessions(id), owner_user_id text, state text, cancel_requested_at timestamptz, deadline_at timestamptz);
      CREATE TABLE messages (id text, account_id text, user_id text, sender text, sender_name text, content text, timestamp timestamptz, is_from_me boolean, is_bot_message boolean, tool_context text, session_id text REFERENCES chat_sessions(id), metadata jsonb, deleted_at timestamptz, PRIMARY KEY(id, account_id));
      CREATE TABLE skill_global_config (skill_name text, globally_enabled boolean);
      CREATE TABLE client_profiles (id text, user_id text, name text, gender text, solar_date text, hour int, minute int, birthplace text, notes text, tags text[], status text, created_at timestamptz, updated_at timestamptz, deleted_at timestamptz);
    `);
      broker.host = new Redis(redisUrl!, {
        lazyConnect: true,
        commandTimeout: 5_000,
      });
      broker.runtime = new Redis(redisUrl!, {
        lazyConnect: true,
        commandTimeout: 5_000,
      });
      await Promise.all([broker.host.connect(), broker.runtime.connect()]);
      consumer = broker.host.duplicate({
        commandTimeout: 5_000,
        lazyConnect: true,
      });
      await consumer.connect();
      vi.stubEnv(
        'FATECLAW_IPC_KEY',
        deriveRuntimeIpcKey('synthetic-paipan-root', `account:${accountId}`),
      );
      serve = (async () => {
        while (!stopped) {
          const entry = await consumer.brpop(
            paipanRequestQueue(accountId),
            visualizationRequestQueue(accountId),
            1,
          );
          if (entry) {
            const process =
              entry[0] === visualizationRequestQueue(accountId)
                ? processVisualizationToolPayload
                : processPaipanToolPayload;
            await process(
              JSON.parse(decodeRuntimeIpc(accountId, entry[0], entry[1])),
              accountId,
            );
          }
        }
      })();
    });

    beforeEach(async () => {
      vi.restoreAllMocks();
      vi.clearAllMocks();
      await getDbPool()
        .query(`TRUNCATE messages, agent_requests, chat_sessions, skill_global_config, client_profiles;
      INSERT INTO chat_sessions(id,account_id,user_id) VALUES ('synthetic-session','${accountId}','synthetic-user');
      INSERT INTO agent_requests VALUES ('${requestId}','${executionId}','${accountId}','synthetic-session','synthetic-user','running',NULL,now()+interval '5 minutes');`);
      for (const skill of listPaipanRegistry())
        await getDbPool().query(
          'INSERT INTO skill_global_config VALUES ($1,true)',
          [skill.name],
        );
    });

    afterAll(async () => {
      stopped = true;
      await serve;
      consumer?.disconnect();
      broker.host?.disconnect();
      broker.runtime?.disconnect();
      await getDbPool().query(
        'DROP TABLE messages, agent_requests, chat_sessions, skill_global_config, client_profiles',
      );
      await closeDbPool();
      vi.unstubAllEnvs();
    });

    it('saves a visualization through authenticated IPC even when the stream notification fails', async () => {
      vi.spyOn(broker.host!, 'publish').mockRejectedValueOnce(
        new Error('Synthetic stream outage'),
      );
      const tools = createPiCustomTools({
        requestScope: createRequestScope(),
        accountId,
        soulStore: { read: vi.fn(), canEdit: vi.fn(), update: vi.fn() },
        recordExecution: vi.fn(),
        visualization: createHostToolCaller('visualization', {
          accountId,
          requestId,
          executionId,
        }),
      });
      const tool = tools.find((item) => item.name === 'render_visualization')!;
      const result = await tool.execute(
        'visual-1',
        {
          type: 'vega-lite',
          title: '示例数量',
          summary: '虚构测试数据。',
          spec: {
            data: { values: [{ element: '木', count: 2 }] },
            mark: 'bar',
            encoding: {
              x: { field: 'element', type: 'nominal' },
              y: { field: 'count', type: 'quantitative' },
            },
          },
        },
        undefined,
        undefined,
        undefined as never,
      );
      expect(result.details).toMatchObject({
        isError: false,
        saved: true,
        reference: expect.stringContaining('```visualization'),
      });
      const stored = await getDbPool().query(
        'SELECT tool_context, metadata FROM messages',
      );
      expect(stored.rowCount).toBe(1);
      expect(stored.rows[0].metadata.kind).toBe('visualization_result');
      expect(
        JSON.parse(stored.rows[0].tool_context)[0].artifactData.spec.data
          .values,
      ).toEqual([{ element: '木', count: 2 }]);
      expect(mockWarn).toHaveBeenCalledWith(
        expect.any(Object),
        'Saved visualization stream notification failed',
      );
    });

    it('runs discovery, calculation, durable card and same-turn reading through authenticated IPC', async () => {
      const scope = createRequestScope();
      const tools = createPiCustomTools({
        requestScope: scope,
        accountId,
        soulStore: { read: vi.fn(), canEdit: vi.fn(), update: vi.fn() },
        recordExecution: vi.fn(),
        paipan: createPaipanCaller({ accountId, requestId, executionId }),
      });
      const create = tools.find((tool) => tool.name === 'create_paipan')!;
      const catalog = await create.execute(
        'catalog',
        { mode: 'catalog' },
        undefined,
        undefined,
        undefined as never,
      );
      expect(catalog.details).toMatchObject({
        isError: false,
        catalog: expect.arrayContaining([
          expect.objectContaining({
            skill: 'bazi-paipan',
            parameters: expect.objectContaining({
              required: ['solarDate', 'hour', 'gender'],
            }),
          }),
        ]),
      });

      const made = await create.execute(
        'create-1',
        { mode: 'create', skill: 'bazi-paipan', input: baziInput },
        undefined,
        undefined,
        undefined as never,
      );
      expect(made.details).toMatchObject({
        isError: false,
        saved: true,
        board: { promptText: expect.stringContaining('庚午 辛巳 庚辰 辛巳') },
      });
      const read = await tools
        .find((tool) => tool.name === 'get_session_board')!
        .execute(
          'read',
          { mode: 'detail' },
          undefined,
          undefined,
          undefined as never,
        );
      expect(read.details).toMatchObject({
        total: 1,
        board: { isCurrent: true, skill: 'bazi-paipan' },
      });
      const messages = await getSessionMessagesWithToolContext(
        accountId,
        'synthetic-session',
      );
      expect(messages).toHaveLength(1);
      expect(buildSessionBoardContexts(messages)[0]).toMatchObject({
        skill: 'bazi-paipan',
        promptText: expect.stringContaining('庚午 辛巳 庚辰 辛巳'),
        isCurrent: true,
      });
      expect(
        (await getDbPool().query('SELECT metadata FROM messages')).rows[0]
          .metadata,
      ).toMatchObject({ kind: 'board_result', request_id: requestId });
    });

    it('serializes concurrent random-chart retries and rejects changed parameters for the same call', async () => {
      const original = request({ method: 'dayan' }, 'jingzhan-paipan');
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          executeConversationPaipan(accountId, {
            ...original,
            rpcId: randomUUID(),
          }),
        ),
      );
      expect(
        results.every(
          (result) => JSON.stringify(result) === JSON.stringify(results[0]),
        ),
      ).toBe(true);
      expect(
        (await getDbPool().query('SELECT id FROM messages')).rowCount,
      ).toBe(1);
      const changed = await executeConversationPaipan(accountId, {
        ...original,
        operation: {
          ...original.operation,
          mode: 'create',
          skill: 'jingzhan-paipan',
          input: { method: 'manual', yao: '777777' },
          toolCallId: 'create-1',
        },
      });
      expect(changed).toMatchObject({
        ok: false,
        code: 'PAIPAN.CALL_CONFLICT',
      });
    });

    it.each([
      "UPDATE agent_requests SET state='completed'",
      'UPDATE agent_requests SET cancel_requested_at=now()',
      "UPDATE agent_requests SET deadline_at=now()-interval '1 second'",
      "UPDATE agent_requests SET execution_id='another-execution'",
      "UPDATE agent_requests SET account_id='another-account'",
      "UPDATE chat_sessions SET user_id='another-user'",
      'UPDATE chat_sessions SET deleted_at=now()',
    ])('refuses an inactive or mismatched request: %s', async (sql) => {
      await getDbPool().query(sql);
      await expect(
        executeConversationPaipan(accountId, request()),
      ).rejects.toBeInstanceOf(InactiveConversationRequestError);
      expect(
        (await getDbPool().query('SELECT id FROM messages')).rowCount,
      ).toBe(0);
    });

    it('keeps the existing parameter limits and enabled-chart policy', async () => {
      await expect(
        executeConversationPaipan(
          accountId,
          request({ ...baziInput, decadeCount: 100_000 }),
        ),
      ).rejects.toMatchObject({ code: 'PAIPAN.PARAM_INVALID' });
      await getDbPool().query(
        'UPDATE skill_global_config SET globally_enabled=false',
      );
      await expect(
        executeConversationPaipan(accountId, request()),
      ).rejects.toMatchObject({ code: 'PAIPAN.SKILL_NOT_ENABLED' });
      expect(
        (await getDbPool().query('SELECT id FROM messages')).rowCount,
      ).toBe(0);
    });

    it('prefills the owned session profile and keeps a committed chart when stream publication fails', async () => {
      await getDbPool()
        .query(`INSERT INTO client_profiles(id,user_id,gender,solar_date,hour,minute) VALUES ('profile-1','synthetic-user','男','1990-05-15',10,30);
      UPDATE chat_sessions SET client_id='profile-1'`);
      vi.spyOn(broker.host!, 'publish').mockRejectedValueOnce(
        new Error('Synthetic stream outage'),
      );
      const result = await createPaipanCaller({
        accountId,
        requestId,
        executionId,
      })({
        mode: 'create',
        skill: 'bazi-paipan',
        input: { include: ['bazi'] },
        toolCallId: 'prefill',
      });
      expect(result).toMatchObject({
        ok: true,
        mode: 'create',
        board: { promptText: expect.stringContaining('庚午 辛巳 庚辰 辛巳') },
      });
      expect(mockWarn).toHaveBeenCalledWith(
        expect.any(Object),
        'Saved paipan stream notification failed',
      );
      expect(
        (await getDbPool().query('SELECT id FROM messages')).rowCount,
      ).toBe(1);
    });
  },
);
