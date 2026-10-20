import { randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { VisualizationIpcRequest } from '@fateclaw/contracts/agent/visualization';
import { visualizationReference } from '@fateclaw/contracts/visualization';

vi.mock('#infrastructure/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('#infrastructure/config', () => ({
  JWT_SECRET: 'synthetic-visualization-root',
}));

import { initDbPool, getDbPool, closeDbPool } from '#infrastructure/db-pool';
import { InactiveConversationRequestError } from '#infrastructure/repositories/conversation-tool-repository';
import {
  executeConversationVisualization,
  resolveMessageVisualizations,
} from '#modules/chat/conversation-visualization-service';

// This suite creates and drops its schema; only an explicitly disposable database is allowed.
const databaseUrl = process.env.FATECLAW_TEST_VISUALIZATION_DATABASE_URL;
const accountId = 'web:synthetic-visualization';
const requestId = 'synthetic-request';
const executionId = 'synthetic-execution';

function request(): VisualizationIpcRequest {
  return {
    rpcId: randomUUID(),
    requestId,
    executionId,
    operation: {
      toolCallId: 'draw-1',
      type: 'vega-lite',
      title: '示例分布',
      summary: '虚构测试数据。',
      spec: {
        data: {
          values: Array.from({ length: 100 }, (_, index) => ({
            category: `row-${index}`,
            count: index,
          })),
        },
        mark: 'bar',
        encoding: {
          x: { field: 'category', type: 'nominal' },
          y: { field: 'count', type: 'quantitative' },
        },
      },
    },
  };
}

describe.skipIf(!databaseUrl)(
  'conversation visualizations with PostgreSQL',
  () => {
    beforeAll(async () => {
      initDbPool(databaseUrl!);
      await getDbPool().query(`
      CREATE TABLE chat_sessions (id text PRIMARY KEY, account_id text, user_id text, client_id text, deleted_at timestamptz, updated_at timestamptz DEFAULT now());
      CREATE TABLE agent_requests (request_id text PRIMARY KEY, execution_id text, account_id text, session_id text REFERENCES chat_sessions(id), owner_user_id text, state text, cancel_requested_at timestamptz, deadline_at timestamptz);
      CREATE TABLE messages (id text, account_id text, user_id text, sender text, sender_name text, content text, timestamp timestamptz, is_from_me boolean, is_bot_message boolean, tool_context text, session_id text REFERENCES chat_sessions(id), metadata jsonb, deleted_at timestamptz, PRIMARY KEY(id, account_id));
    `);
    });
    beforeEach(async () => {
      await getDbPool().query(
        'TRUNCATE messages, agent_requests, chat_sessions',
      );
      await getDbPool().query(
        "INSERT INTO chat_sessions (id,account_id,user_id) VALUES ('synthetic-session',$1,'synthetic-user')",
        [accountId],
      );
      await getDbPool().query(
        "INSERT INTO agent_requests VALUES ($1,$2,$3,'synthetic-session','synthetic-user','running',NULL,now()+interval '5 minutes')",
        [requestId, executionId, accountId],
      );
    });
    afterAll(async () => {
      await getDbPool().query(
        'DROP TABLE messages, agent_requests, chat_sessions',
      );
      await closeDbPool();
    });

    it('commits one complete artifact across concurrent retries and hydrates references in answer order', async () => {
      const original = request();
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          executeConversationVisualization(accountId, {
            ...original,
            rpcId: randomUUID(),
          }),
        ),
      );
      for (const result of results) expect(result).toEqual(results[0]);
      const first = results[0];
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error('Expected a saved artifact');
      const stored = await getDbPool().query(
        'SELECT tool_context FROM messages',
      );
      expect(stored.rowCount).toBe(1);
      expect(stored.rows[0].tool_context.length).toBeGreaterThan(2000);
      expect(
        JSON.parse(stored.rows[0].tool_context)[0].artifactData.spec,
      ).toEqual(original.operation.spec);
      const second = await executeConversationVisualization(accountId, {
        ...original,
        operation: {
          ...original.operation,
          toolCallId: 'draw-2',
          title: '另一张图',
        },
      });
      if (!second.ok) throw new Error('Expected another saved artifact');
      const content = `说明\n\n${visualizationReference(second.artifact.id)}\n\n分析\n\n${visualizationReference(first.artifact.id)}`;
      const entries = await resolveMessageVisualizations(
        accountId,
        'synthetic-session',
        content,
        getDbPool(),
      );
      expect(entries.map((entry) => entry.artifactTitle)).toEqual([
        '另一张图',
        '示例分布',
      ]);
      expect(
        await resolveMessageVisualizations(
          accountId,
          'another-session',
          content,
          getDbPool(),
        ),
      ).toEqual([]);
      expect(
        await resolveMessageVisualizations(
          'another-account',
          'synthetic-session',
          content,
          getDbPool(),
        ),
      ).toEqual([]);
      const conflict = await executeConversationVisualization(accountId, {
        ...original,
        operation: { ...original.operation, title: 'Changed' },
      });
      expect(conflict).toMatchObject({
        ok: false,
        code: 'VISUALIZATION.CALL_CONFLICT',
      });
    });

    it.each([
      "UPDATE agent_requests SET state='completed'",
      'UPDATE agent_requests SET cancel_requested_at=now()',
      "UPDATE agent_requests SET deadline_at=now()-interval '1 second'",
      "UPDATE agent_requests SET execution_id='another-execution'",
      "UPDATE chat_sessions SET user_id='another-user'",
      'UPDATE chat_sessions SET deleted_at=now()',
    ])('rejects inactive ownership before persisting: %s', async (sql) => {
      await getDbPool().query(sql);
      await expect(
        executeConversationVisualization(accountId, request()),
      ).rejects.toBeInstanceOf(InactiveConversationRequestError);
      expect(
        (await getDbPool().query('SELECT id FROM messages')).rowCount,
      ).toBe(0);
    });

    it('parses Mermaid in isolation and rejects malformed syntax and invalid chart schemas', async () => {
      const original = request();
      const valid = await executeConversationVisualization(accountId, {
        ...original,
        operation: {
          ...original.operation,
          type: 'mermaid',
          spec: 'flowchart LR\nA["盘面"] --> B["依据"]',
        },
      });
      expect(valid.ok).toBe(true);
      const broken = await executeConversationVisualization(accountId, {
        ...original,
        operation: {
          ...original.operation,
          type: 'mermaid',
          spec: 'flowchart LR\nA[broken',
        },
      });
      expect(broken).toMatchObject({
        ok: false,
        code: 'VISUALIZATION.INVALID_SPEC',
      });
      const schema = await executeConversationVisualization(accountId, {
        ...original,
        operation: {
          ...original.operation,
          type: 'vega-lite',
          spec: {
            data: { values: [] },
            mark: 'bar',
            encoding: { x: { field: 'x', type: 'invalid' } },
          },
        },
      });
      expect(schema).toMatchObject({
        ok: false,
        code: 'VISUALIZATION.INVALID_SPEC',
      });
      const expression = await executeConversationVisualization(accountId, {
        ...original,
        operation: {
          ...original.operation,
          type: 'vega-lite',
          spec: {
            data: { values: [{ count: 1 }] },
            mark: 'bar',
            transform: [{ filter: 'datum.count >' }],
          },
        },
      });
      expect(expression).toMatchObject({
        ok: false,
        code: 'VISUALIZATION.INVALID_SPEC',
      });
      expect(
        (await getDbPool().query('SELECT id FROM messages')).rowCount,
      ).toBe(1);
    });
  },
);
