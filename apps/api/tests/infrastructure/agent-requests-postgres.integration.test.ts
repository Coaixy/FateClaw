import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  closeDbPool,
  getDbPool,
  initDbPool,
} from '../../src/infrastructure/db-pool.js';
vi.mock('../../src/infrastructure/config.js', () => ({
  MAX_OVERDRAFT_COINS: 50,
}));
import { listStalePendingReservations } from '../../src/infrastructure/repositories/billing-repository.js';
import { durableAgentRequestsMigration } from '../../src/infrastructure/migrations/definitions/0076-durable-agent-requests.js';
import {
  admitAgentRequest,
  markAgentRequestDispatched,
  requestAgentCancellation,
  takeRecoverableRequests,
  withAgentResultDelivery,
  withAgentInterruptionDelivery,
  acknowledgeAgentInterruption,
} from '../../src/infrastructure/repositories/agent-requests-repository.js';
import type { AiChatSubmission } from '../../src/runtime/ipc-worker.js';
import type { LlmRuntimeSnapshot } from '../../src/runtime/ipc-payloads.js';

// Run only against an explicitly supplied disposable database, never DATABASE_URL.
const connectionString = process.env.FATECLAW_TEST_DURABLE_DATABASE_URL;
const runtime: LlmRuntimeSnapshot = {
  source: 'official',
  billingMode: 'metered',
  modelConfigId: 'synthetic',
  piApi: 'openai-completions',
  model: 'synthetic',
  apiKey: 'synthetic-not-a-secret',
  authMode: 'openai_api_key',
  providerKey: 'synthetic',
};
function admission(requestId = 'request-1', sessionId = 'session-1') {
  const input = {
    accountId: 'web:user-1',
    sessionId,
    requestId,
    userMessage: 'Synthetic request',
    userMessageId: `message-${requestId}`,
    messageToPersist: {
      id: `message-${requestId}`,
      account_id: 'web:user-1',
      user_id: 'user-1',
      sender: 'user-1',
      sender_name: 'Synthetic',
      content: 'Synthetic request',
      timestamp: new Date().toISOString(),
      session_id: sessionId,
    },
  } as AiChatSubmission;
  return {
    input,
    requestId,
    ownerUserId: 'user-1',
    runtime,
    deadlineAt: Date.now() + 60_000,
  };
}

describe.skipIf(!connectionString)(
  'durable requests PostgreSQL integration',
  () => {
    beforeAll(async () => {
      const pool = initDbPool(connectionString!);
      const client = await pool.connect();
      try {
        await durableAgentRequestsMigration.up(client);
      } finally {
        client.release();
      }
      await pool.query(`CREATE TABLE messages (
      id text, account_id text, user_id text, sender text, sender_name text,
      content text NOT NULL, timestamp timestamptz, is_from_me boolean,
      is_bot_message boolean, tool_context text, session_id text, metadata jsonb,
      PRIMARY KEY (id, account_id));
      CREATE TABLE synthetic_deliveries (id text PRIMARY KEY);
      CREATE TABLE billing_request_reservations (request_id text PRIMARY KEY, charge_state text, created_at timestamptz);
      CREATE TABLE conversation_logs (request_id text)`);
    });
    beforeEach(async () => {
      await getDbPool().query(
        'TRUNCATE agent_requests, agent_result_deliveries, messages, synthetic_deliveries, billing_request_reservations, conversation_logs',
      );
    });
    afterAll(async () => {
      await getDbPool().query(
        'DROP TABLE synthetic_deliveries, messages, agent_result_deliveries, agent_requests, billing_request_reservations, conversation_logs',
      );
      await closeDbPool();
    });

    it('commits admission and user message together without persisting credentials', async () => {
      await admitAgentRequest(admission());
      const { rows } = await getDbPool().query(
        'SELECT runtime,input,state FROM agent_requests',
      );
      expect(rows[0].state).toBe('queued');
      expect(rows[0].runtime).not.toHaveProperty('apiKey');
      expect(rows[0].input).not.toHaveProperty('messageToPersist');
      expect(
        (await getDbPool().query('SELECT id FROM messages')).rowCount,
      ).toBe(1);
    });

    it('rolls back admission when message persistence fails', async () => {
      const args = admission();
      args.input.messageToPersist!.content = null as never;
      await expect(admitAgentRequest(args)).rejects.toMatchObject({
        code: '23502',
      });
      expect(
        (await getDbPool().query('SELECT request_id FROM agent_requests'))
          .rowCount,
      ).toBe(0);
    });

    it('does not overwrite a previous admission with duplicate request id', async () => {
      await admitAgentRequest(admission());
      await expect(admitAgentRequest(admission())).rejects.toThrow(
        'already been admitted',
      );
      expect(
        (await getDbPool().query('SELECT request_id FROM agent_requests'))
          .rowCount,
      ).toBe(1);
    });

    it('prevents canceled queued requests from dispatching', async () => {
      await admitAgentRequest(admission());
      await requestAgentCancellation('request-1');
      expect(await markAgentRequestDispatched('request-1')).toBe(false);
    });

    it('leases abandoned requests once across concurrent recovery readers', async () => {
      await admitAgentRequest(admission());
      await getDbPool().query(
        "UPDATE agent_requests SET lease_until=now()-interval '1 minute'",
      );
      const recovered = await Promise.all([
        takeRecoverableRequests(),
        takeRecoverableRequests(),
      ]);
      expect(recovered.flat().map((row) => row.request_id)).toEqual([
        'request-1',
      ]);
    });

    it('runs result delivery once for concurrent duplicate results', async () => {
      await admitAgentRequest(admission());
      let deliveries = 0;
      const deliver = async (client: import('pg').PoolClient) => {
        deliveries += 1;
        await client.query(
          "INSERT INTO synthetic_deliveries VALUES ('final-1')",
        );
        return 'final-1';
      };
      const results = await Promise.all([
        withAgentResultDelivery('request-1', 'web:user-1', deliver),
        withAgentResultDelivery('request-1', 'web:user-1', deliver),
      ]);
      expect(results).toEqual(['final-1', 'final-1']);
      expect(deliveries).toBe(1);
      expect(
        (await getDbPool().query('SELECT state FROM agent_requests')).rows[0]
          .state,
      ).toBe('completed');
    });

    it('rolls back failed delivery and permits a later successful retry', async () => {
      await admitAgentRequest(admission());
      await expect(
        withAgentResultDelivery('request-1', 'web:user-1', async (client) => {
          await client.query(
            "INSERT INTO synthetic_deliveries VALUES ('final-1')",
          );
          throw new Error('synthetic failure before commit');
        }),
      ).rejects.toThrow('synthetic failure');
      expect(
        (await getDbPool().query('SELECT * FROM synthetic_deliveries'))
          .rowCount,
      ).toBe(0);
      expect(
        (await getDbPool().query('SELECT * FROM agent_result_deliveries'))
          .rowCount,
      ).toBe(0);
      expect(
        await withAgentResultDelivery(
          'request-1',
          'web:user-1',
          async () => 'final-2',
        ),
      ).toBe('final-2');
    });

    it('rejects the first delivery when it disagrees with the admitted account', async () => {
      await admitAgentRequest(admission());
      let called = false;
      await expect(
        withAgentResultDelivery('request-1', 'web:other', async () => {
          called = true;
          return 'bad';
        }),
      ).rejects.toThrow('account mismatch');
      expect(called).toBe(false);
      expect(
        (await getDbPool().query('SELECT * FROM agent_result_deliveries'))
          .rowCount,
      ).toBe(0);
      expect(
        (await getDbPool().query('SELECT state FROM agent_requests')).rows[0]
          .state,
      ).toBe('queued');
    });

    it.each(['result_ready', 'completed'])(
      'suppresses interruption notices after an actual %s result',
      async (state) => {
        await admitAgentRequest(admission());
        await getDbPool().query(
          'UPDATE agent_requests SET state=$1,result=$2',
          [state, JSON.stringify({ text: 'actual result' })],
        );
        let calls = 0;
        expect(
          await withAgentInterruptionDelivery(
            'request-1',
            'web:user-1',
            async () => {
              calls += 1;
              return 'synthetic';
            },
          ),
        ).toBeNull();
        expect(calls).toBe(0);
        expect(
          (await getDbPool().query('SELECT state,result FROM agent_requests'))
            .rows[0],
        ).toMatchObject({ state, result: { text: 'actual result' } });
      },
    );

    it('serializes a synthetic notice with actual delivery and preserves the final actual message', async () => {
      await admitAgentRequest(admission());
      await getDbPool().query("UPDATE agent_requests SET state='interrupted'");
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const synthetic = withAgentInterruptionDelivery(
        'request-1',
        'web:user-1',
        async (client) => {
          await client.query("UPDATE messages SET content='synthetic notice'");
          enter();
          await gate;
          return 'synthetic-message';
        },
      );
      await entered;
      let actualCallbackStarted = false;
      const actual = withAgentResultDelivery(
        'request-1',
        'web:user-1',
        async (client) => {
          actualCallbackStarted = true;
          await client.query("UPDATE messages SET content='actual result'");
          return 'actual-message';
        },
      );
      try {
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const { rowCount } = await getDbPool()
            .query(`SELECT 1 FROM pg_stat_activity
            WHERE datname=current_database() AND wait_event_type='Lock'
              AND query LIKE 'SELECT account_id FROM agent_requests%'`);
          if (rowCount) {
            waiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        expect(actualCallbackStarted).toBe(false);
      } finally {
        release();
      }
      expect(await synthetic).toBe('synthetic-message');
      expect(await actual).toBe('actual-message');
      expect(
        await withAgentInterruptionDelivery(
          'request-1',
          'web:user-1',
          async () => {
            throw new Error('must not overwrite actual result');
          },
        ),
      ).toBeNull();
      expect(
        (await getDbPool().query('SELECT content FROM messages')).rows[0]
          .content,
      ).toBe('actual result');
      expect(
        (
          await getDbPool().query(
            'SELECT final_message_id FROM agent_result_deliveries',
          )
        ).rows[0].final_message_id,
      ).toBe('actual-message');
    });

    it('recovers one expired request at a time and stops recovering an acknowledged interruption', async () => {
      await admitAgentRequest(admission('request-1', 'session-1'));
      await admitAgentRequest(admission('request-2', 'session-2'));
      await getDbPool().query(
        "UPDATE agent_requests SET lease_until=NULL, state='interrupted'",
      );
      const first = await takeRecoverableRequests();
      expect(first).toHaveLength(1);
      await acknowledgeAgentInterruption(first[0].request_id);
      const second = await takeRecoverableRequests();
      expect(second).toHaveLength(1);
      expect(second[0].request_id).not.toBe(first[0].request_id);
      await acknowledgeAgentInterruption(second[0].request_id);
      expect(await takeRecoverableRequests()).toEqual([]);
    });

    it('enforces one active writer per session while allowing another session to execute', async () => {
      await admitAgentRequest(admission('request-1', 'shared-session'));
      await admitAgentRequest(admission('request-2', 'shared-session'));
      await admitAgentRequest(admission('request-3', 'other-session'));
      await getDbPool().query(
        "UPDATE agent_requests SET state='running' WHERE request_id='request-1'",
      );
      await expect(
        getDbPool().query(
          "UPDATE agent_requests SET state='running' WHERE request_id='request-2'",
        ),
      ).rejects.toMatchObject({ code: '23505' });
      await getDbPool().query(
        "UPDATE agent_requests SET state='running' WHERE request_id='request-3'",
      );
      expect(
        (
          await getDbPool().query(
            "SELECT request_id FROM agent_requests WHERE state='running'",
          )
        ).rowCount,
      ).toBe(2);
    });

    it('keeps unknown and synthetic requests out of the billing batch while selecting undelivered actual usage', async () => {
      for (const [id, state, result] of [
        ['unknown', 'interrupted', { usage: { promptTokens: 0 } }],
        [
          'synthetic',
          'result_ready',
          {
            metadata: { synthetic_terminal: true },
            usage: { promptTokens: 0 },
          },
        ],
        ['missing', 'result_ready', {}],
        [
          'actual',
          'result_ready',
          { usage: { promptTokens: 120, completionTokens: 30 } },
        ],
      ] as const) {
        await admitAgentRequest(admission(id, `session-${id}`));
        await getDbPool().query(
          'UPDATE agent_requests SET state=$2,result=$3 WHERE request_id=$1',
          [id, state, JSON.stringify(result)],
        );
        await getDbPool().query(
          `INSERT INTO billing_request_reservations VALUES ($1,'pending',now()-interval '3 hours')`,
          [id],
        );
      }
      // Model result committed separately; a failed message delivery creates no receipt/log.
      await expect(
        withAgentResultDelivery('actual', 'web:user-1', async (client) => {
          await client.query("INSERT INTO conversation_logs VALUES ('actual')");
          throw new Error('synthetic final message failure');
        }),
      ).rejects.toThrow('final message failure');
      expect(
        (await getDbPool().query('SELECT * FROM conversation_logs')).rowCount,
      ).toBe(0);
      const selected = await listStalePendingReservations(
        new Date().toISOString(),
        1,
      );
      expect(selected.map((row) => row.request_id)).toEqual(['actual']);
    });

    it('rejects result reuse for a different account', async () => {
      await withAgentResultDelivery(
        'request-1',
        'web:user-1',
        async () => 'final-1',
      );
      await expect(
        withAgentResultDelivery('request-1', 'web:other', async () => 'bad'),
      ).rejects.toThrow('account mismatch');
    });
  },
);
