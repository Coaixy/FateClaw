import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  initDbPool,
  getDbPool,
  closeDbPool,
} from '../../src/infrastructure/db-pool.js';
import { piSessionFramesMigration } from '../../src/infrastructure/migrations/versions/0094-pi-session-frames.js';
import { durableAgentRequestsMigration } from '../../src/infrastructure/migrations/versions/0076-durable-agent-requests.js';
import {
  storeConversationLog,
  getConversationLogByRequestId,
  purgeExpiredTraceEvents,
} from '../../src/infrastructure/repositories/conversation-log-repository.js';
import {
  getPiSessionBase,
  getPiSessionSnapshot,
} from '../../src/infrastructure/repositories/pi-session-frames-repository.js';
import { withAgentResultDelivery } from '../../src/infrastructure/repositories/agent-requests-repository.js';
import { createPiSessionFrame } from '@fateclaw/contracts/agent/session';
import type { PiSessionFrame } from '@fateclaw/contracts/agent';

const connectionString = process.env.FATECLAW_TEST_FRAMES_DATABASE_URL;
describe.skipIf(!connectionString)(
  'Pi session frames PostgreSQL integration',
  () => {
    beforeAll(async () => {
      const pool = initDbPool(connectionString!);
      await pool.query(`CREATE TABLE chat_sessions(id text PRIMARY KEY,account_id text NOT NULL);
      CREATE TABLE conversation_logs(id text PRIMARY KEY,account_id text,request_id text,usage jsonb,model text,provider text,
        transcript_event_count int,tool_call_count int,trace_event_count int,agent_graph_summary jsonb,capability_ledger jsonb,created_at timestamptz);
      CREATE TABLE conversation_log_payloads(log_id text PRIMARY KEY REFERENCES conversation_logs(id) ON DELETE CASCADE,
        transcript jsonb,trace_events jsonb,agent_graph jsonb)`);
      const client = await pool.connect();
      try {
        await durableAgentRequestsMigration.up(client);
        await piSessionFramesMigration.up(client);
      } finally {
        client.release();
      }
    });
    beforeEach(async () => {
      await getDbPool().query(
        'TRUNCATE chat_sessions,pi_session_frames,conversation_logs,conversation_log_payloads,agent_requests,agent_result_deliveries CASCADE',
      );
      await getDbPool().query(
        "INSERT INTO chat_sessions VALUES ('session','web:user')",
      );
    });
    afterAll(async () => {
      await getDbPool().query(
        'DROP TABLE pi_session_frames,conversation_log_payloads,conversation_logs,chat_sessions,agent_result_deliveries,agent_requests',
      );
      await closeDbPool();
    });

    async function frame(
      requestId: string,
      messages: unknown[],
    ): Promise<PiSessionFrame> {
      return createPiSessionFrame(
        {
          persisted: true,
          provider: 'synthetic',
          model: 'synthetic',
          userPrompt: requestId,
          systemPrompt: 'synthetic',
          appendSystemPrompt: [],
          allowedTools: [],
          readableSkills: [],
          messageCount: messages.length,
          messages,
        },
        await getPiSessionBase('session', 'web:user'),
      );
    }
    async function deliver(
      requestId: string,
      value: PiSessionFrame,
      fail = false,
    ) {
      await getDbPool().query(
        `INSERT INTO agent_requests(request_id,execution_id,account_id,session_id,owner_user_id,state,input,runtime,deadline_at)
      VALUES($1,$1,'web:user','session','user','result_ready','{}','{}',now()+interval '1 minute') ON CONFLICT DO NOTHING`,
        [requestId],
      );
      return withAgentResultDelivery(requestId, 'web:user', async (db) => {
        await storeConversationLog(
          {
            id: requestId,
            requestId,
            accountId: 'web:user',
            sessionId: 'session',
            transcript: [{ type: 'tool_use' }],
            traceEvents: [
              { type: 'agent_timing', stage: 'generation', durationMs: 42 },
            ],
            piSession: value,
          },
          db,
        );
        if (fail) throw new Error('synthetic delivery failure');
        return `reply-${requestId}`;
      });
    }

    it('atomically rolls back frames and logs, then delivers once and reconstructs across JSONB and trace retention', async () => {
      const first = await frame('first', [
        { role: 'user', content: 'synthetic' },
      ]);
      await expect(deliver('first', first, true)).rejects.toThrow(
        'synthetic delivery failure',
      );
      expect(await getPiSessionBase('session', 'web:user')).toBeUndefined();
      expect(
        (await getDbPool().query('SELECT * FROM conversation_logs')).rowCount,
      ).toBe(0);
      await Promise.all([deliver('first', first), deliver('first', first)]);
      const second = await frame('second', [
        ...first.messages,
        { role: 'assistant', content: 'answer' },
      ]);
      expect(second.kind).toBe('delta');
      await deliver('second', second);
      const log = await getConversationLogByRequestId('second');
      expect(log?.trace_events).toContainEqual({
        type: 'agent_timing',
        stage: 'generation',
        durationMs: 42,
      });
      expect(
        log?.trace_events?.find(
          (event) => (event as { type: string }).type === 'pi_session_snapshot',
        ),
      ).toMatchObject({
        session: {
          messageCount: 2,
          messages: [
            { role: 'user', content: 'synthetic' },
            { role: 'assistant', content: 'answer' },
          ],
        },
      });
      expect(
        (
          await getDbPool().query(
            'SELECT count(*)::int AS n FROM pi_session_frames',
          )
        ).rows[0].n,
      ).toBe(2);
      expect(
        (
          await getDbPool().query(
            "SELECT tool_call_count FROM conversation_logs WHERE request_id='second'",
          )
        ).rows[0].tool_call_count,
      ).toBe(1);
      await getDbPool().query(
        "UPDATE conversation_logs SET created_at=now()-interval '40 days'",
      );
      await purgeExpiredTraceEvents(30);
      expect(
        (await getPiSessionSnapshot('second', 'web:user'))?.messages,
      ).toHaveLength(2);
      expect(await getPiSessionSnapshot('second', 'web:other')).toBeUndefined();
    });

    it('rejects a delta whose committed dependency belongs to another session', async () => {
      const first = await frame('first', [
        { role: 'user', content: 'synthetic' },
      ]);
      await deliver('first', first);
      const second = await frame('second', [
        ...first.messages,
        { role: 'assistant', content: 'answer' },
      ]);
      await getDbPool().query(
        "INSERT INTO chat_sessions VALUES ('other','web:user')",
      );
      await getDbPool().query(
        "UPDATE pi_session_frames SET session_id='other' WHERE request_id='first'",
      );
      await expect(deliver('second', second)).rejects.toThrow(
        'Missing committed Pi session base',
      );
      expect(
        (
          await getDbPool().query(
            "SELECT * FROM conversation_logs WHERE request_id='second'",
          )
        ).rowCount,
      ).toBe(0);
    });
    it('keeps admission order when an older checkpoint arrives after a newer result', async () => {
      await getDbPool()
        .query(`INSERT INTO agent_requests(request_id,execution_id,account_id,session_id,owner_user_id,state,input,runtime,deadline_at,created_at)
      VALUES('older','older','web:user','session','user','result_ready','{}','{}',now()+interval '1 minute',now()-interval '1 minute'),
      ('newer','newer','web:user','session','user','result_ready','{}','{}',now()+interval '1 minute',now())`);
      const older = await frame('older', [{ role: 'user', content: 'older' }]);
      const newer = await frame('newer', [{ role: 'user', content: 'newer' }]);
      await deliver('newer', newer);
      await deliver('older', older);
      expect((await getPiSessionBase('session', 'web:user'))?.requestId).toBe(
        'newer',
      );
    });
  },
);
