import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_BENEFIT_POLICY,
  type RuntimeModelPoolNode,
} from '@fateclaw/contracts/model-settings';

const state = vi.hoisted(() => ({
  pool: null as pg.Pool | null,
  publish: vi.fn(async () => 1),
}));
vi.mock('#infrastructure/env', () => ({ readEnvFile: () => ({}) }));
vi.mock('#infrastructure/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#infrastructure/config')>()),
  DATABASE_URL: 'postgresql://synthetic-disposable-client',
}));
vi.mock('#infrastructure/db-pool', () => ({
  getDbPool: () => state.pool,
  initDbPool: () => state.pool,
  closeDbPool: async () => {
    await state.pool?.end();
  },
}));
vi.mock('../../../agent-runtime/src/agent-db.js', () => ({
  getAgentDbPool: () => state.pool,
}));
vi.mock('#infrastructure/redis', () => ({
  getRedis: () => ({ publish: state.publish, eval: async () => 1 }),
}));
vi.mock('#infrastructure/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('#runtime/local-runner', () => ({
  releaseLocalAgent: vi.fn(async () => undefined),
}));
vi.mock('#modules/skills/legacy-skill-import', () => ({
  importLegacySkillContent: async () => ({
    migrated: 0,
    missing: 0,
    mismatched: 0,
    invalid: 0,
  }),
}));

import { initDatabase, closeDatabase, deleteUser } from '#infrastructure/db';
import { settleRechargeOrderPaid } from '#infrastructure/repositories/billing-repository';
import {
  archiveChatSession,
  storeMessage,
} from '#infrastructure/repositories/chat-repository';
import { claimOutboundIpcReceipt } from '#infrastructure/repositories/ipc-receipts-repository';
import { claimDurableExecution } from '../../../agent-runtime/src/durable-execution.js';
import type { InboxRequest } from '../../../agent-runtime/src/types.js';
import {
  admitAgentRequest,
  withAgentResultDelivery,
} from '#infrastructure/repositories/agent-requests-repository';
import {
  getBenefitAllowance,
  getBenefitSupply,
  settleBenefitTurn,
  tryAcquireBenefitExecutionSlot,
} from '#infrastructure/repositories/benefit-repository';
import {
  getPlatformModelRuntimeSettings,
  savePlatformModelConfig,
} from '#infrastructure/repositories/config-repository';
import { createPiProviderRuntime } from '../../../agent-runtime/src/pi-runtime/provider.js';
import { installModelPool } from '../../../agent-runtime/src/pi-runtime/model-pool.js';
import { processAiChatOutboxPayload } from '#runtime/ipc-ai-chat-outbox-handler';
import type {
  LlmRuntimeSnapshot,
  PendingInboxRequest,
} from '#runtime/ipc-payloads';

const connectionString = process.env.FATECLAW_TEST_SECURITY_DATABASE_URL;
describe.skipIf(!connectionString)(
  'security boundaries against current source and schema',
  () => {
    let admin: pg.Pool;
    const databaseName = `fateclaw_security_${randomUUID().replaceAll('-', '')}`;
    let mode: 'stall' | '429' = 'stall';
    let calls = 0;
    let nodes: RuntimeModelPoolNode[];
    const server = createServer((_request, response) => {
      calls += 1;
      if (mode === 'stall') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.flushHeaders();
      } else {
        response.writeHead(429, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ error: { message: 'rate limit exceeded' } }),
        );
      }
    });
    beforeAll(async () => {
      admin = new pg.Pool({ connectionString });
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      const url = new URL(connectionString!);
      url.pathname = `/${databaseName}`;
      state.pool = new pg.Pool({ connectionString: url.toString(), max: 5 });
      await initDatabase();
      await state.pool.query(`
      INSERT INTO users(id,phone,created_at) VALUES
        ('review-attacker','13000000001',now()),('review-victim','13000000002',now());
      INSERT INTO chat_sessions(id,account_id,user_id,title,model_pool_key) VALUES
        ('review-attacker-session','web:review-attacker','review-attacker','Synthetic','benefit'),
        ('review-victim-session','web:review-victim','review-victim','Synthetic','official');
      INSERT INTO user_memberships(user_id,plan_key,status,current_period_start,current_period_end)
        VALUES('review-attacker','membership','active',now()-interval '1 day',now()+interval '1 day');
    `);
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
      await savePlatformModelConfig({
        poolKey: 'benefit',
        displayName: 'Synthetic review',
        thinkingLevel: 'off',
        enabled: true,
        benefitPolicy: DEFAULT_BENEFIT_POLICY,
        inputTokenPricePerMillionCoins: 0,
        outputTokenPricePerMillionCoins: 0,
        nodes: ['one', 'two'].map((id) => ({
          displayName: id,
          piApi: 'openai-completions' as const,
          baseUrl,
          modelName: 'synthetic-model',
          secretValue: 'synthetic-provider-value',
          contextWindowTokens: 32000,
          enabled: true,
          weight: 1,
        })),
      });
      const settings = await getPlatformModelRuntimeSettings('benefit');
      nodes = settings.nodes.map((entry) => ({
        modelConfigId: entry.model.id,
        revision: entry.revision,
        weight: 1,
        piApi: 'openai-completions',
        model: 'synthetic-model',
        providerKey: 'synthetic',
        authMode: 'openai_api_key',
        apiKey: 'synthetic-provider-value',
        poolKey: 'benefit',
        baseUrl,
      }));
    });
    afterAll(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await closeDatabase();
      await admin.query(`DROP DATABASE "${databaseName}"`);
      await admin.end();
    });
    async function admitAndStart(selectedNodes = nodes) {
      const id = randomUUID();
      const runtime: LlmRuntimeSnapshot = {
        ...selectedNodes[0],
        source: 'official',
        billingMode: 'none',
        poolKey: 'benefit',
        benefitRequestId: id,
        benefitPolicy: DEFAULT_BENEFIT_POLICY,
        poolNodes: selectedNodes,
        contextWindowTokens: 32000,
        maxOutputTokens: 100,
      };
      await admitAgentRequest({
        requestId: id,
        ownerUserId: 'review-attacker',
        runtime,
        deadlineAt: Date.now() + 60_000,
        input: {
          accountId: 'web:review-attacker',
          sessionId: 'review-attacker-session',
          userMessage: 'Synthetic question',
          history: [],
        },
      });
      expect(await tryAcquireBenefitExecutionSlot(id)).toBe(true);
      await state.pool!.query(
        "UPDATE agent_requests SET state='running' WHERE request_id=$1",
        [id],
      );
      return { id, runtime };
    }
    async function complete(runtime: LlmRuntimeSnapshot, timeout = 1_000) {
      const provider = await createPiProviderRuntime(runtime);
      installModelPool(provider, runtime, {
        random: () => 0,
        firstContentTimeoutMs: timeout,
      });
      return provider.modelRuntime.completeSimple(provider.model, {
        messages: [
          { role: 'user', content: 'Synthetic question', timestamp: 1 },
        ],
      });
    }
    async function settleFailure(id: string) {
      await withAgentResultDelivery(id, 'web:review-attacker', async (db) => {
        expect(await settleBenefitTurn(db, id, false)).toBe('released');
        return null;
      });
    }

    it('releases a local timeout without cooling a shared node and gates refunded retries', async () => {
      mode = 'stall';
      const { id, runtime } = await admitAndStart([nodes[0]]);
      expect((await complete(runtime, 50)).stopReason).toBe('error');
      const row = (
        await state.pool!.query(
          `SELECT failure_count,cooldown_reason,
      EXTRACT(EPOCH FROM cooldown_until-now())::float8 AS seconds
      FROM official_model_pool_nodes WHERE model_config_id=$1`,
          [nodes[0].modelConfigId],
        )
      ).rows[0];
      expect(row).toMatchObject({
        failure_count: 0,
        cooldown_reason: null,
        seconds: null,
      });
      await settleFailure(id);
      expect(
        (await getBenefitAllowance('review-attacker', 3)).remaining_turns,
      ).toBe(3);
      await expect(admitAndStart()).rejects.toThrow('30 秒');
      await settleFailure(id);
      expect(
        (
          await state.pool!.query(
            "SELECT failed_turns FROM benefit_daily_usage WHERE user_id='review-attacker'",
          )
        ).rows[0].failed_turns,
      ).toBe(1);
    });

    it('bounds refunded dispatched requests without taking away successful-turn allowance', async () => {
      mode = '429';
      const before = calls;
      await state.pool!.query(
        'UPDATE benefit_daily_usage SET failed_turns=0,retry_after_at=NULL',
      );
      for (let index = 0; index < 3; index += 1) {
        // Simulate cooldown expiry on the disposable database; preserve failure generations.
        await state.pool!.query(
          "UPDATE official_model_pool_nodes SET cooldown_until=CASE WHEN cooldown_until IS NULL THEN NULL ELSE now()-interval '1 second' END",
        );
        await state.pool!.query(
          "UPDATE benefit_daily_usage SET retry_after_at=now()-interval '1 second'",
        );
        const { id, runtime } = await admitAndStart();
        expect((await complete(runtime)).stopReason).toBe('error');
        expect(await getBenefitSupply()).toBe('busy');
        await settleFailure(id);
        expect(
          (await getBenefitAllowance('review-attacker', 3)).remaining_turns,
        ).toBe(3);
      }
      await expect(admitAndStart()).rejects.toThrow('失败重试次数已用完');
      expect(calls - before).toBe(6);
      const usage = (
        await state.pool!.query(
          "SELECT consumed_turns,reserved_turns FROM benefit_daily_usage WHERE user_id='review-attacker'",
        )
      ).rows[0];
      expect(usage).toEqual({ consumed_turns: 0, reserved_turns: 0 });
    });

    it.each(['pending', 'paid', 'failed'])(
      'deletes a user with a %s order and skill invite while retaining the order',
      async (status) => {
        const id = `review-order-${status}`;
        await state.pool!.query(
          'INSERT INTO users(id,phone,created_at) VALUES($1,$2,now())',
          [
            id,
            `1300000000${status === 'pending' ? 3 : status === 'paid' ? 4 : 5}`,
          ],
        );
        await state.pool!.query(
          "INSERT INTO chat_sessions(id,account_id,user_id,title) VALUES($1,$2,$3,'Synthetic')",
          [`${id}-session`, `web:${id}`, id],
        );
        await state.pool!.query(
          "INSERT INTO recharge_orders(id,user_id,trade_id,pay_type,amount_coins,status,credit_status) VALUES($1,$2,$1,'alipay',1,$3,$4)",
          [
            `${id}-order`,
            id,
            status,
            status === 'paid' ? 'credited' : 'pending',
          ],
        );
        await state.pool!.query(
          "INSERT INTO skill_access_invites(id,creator_id,target_type,target_id,token) VALUES($1,$2,'skill','synthetic-skill',$1)",
          [`${id}-invite`, id],
        );
        if (status === 'paid')
          await state.pool!.query(
            "INSERT INTO completed_recharge_refunds(id,recharge_order_id,amount_cents,reference,reason) VALUES('retained-refund',$1,50,'synthetic-refund','Synthetic refund')",
            [`${id}-order`],
          );
        await deleteUser(id);
        expect(
          (await state.pool!.query('SELECT id FROM users WHERE id=$1', [id]))
            .rowCount,
        ).toBe(0);
        expect(
          (
            await state.pool!.query(
              'SELECT id FROM chat_sessions WHERE user_id=$1',
              [id],
            )
          ).rowCount,
        ).toBe(0);
        expect(
          (
            await state.pool!.query(
              'SELECT id FROM skill_access_invites WHERE creator_id=$1',
              [id],
            )
          ).rowCount,
        ).toBe(0);
        expect(
          (
            await state.pool!.query(
              'SELECT user_id,status FROM recharge_orders WHERE id=$1',
              [`${id}-order`],
            )
          ).rows,
        ).toEqual([{ user_id: null, status }]);
        if (status === 'paid')
          expect(
            (
              await state.pool!.query(
                "SELECT 1 FROM completed_recharge_refunds WHERE id='retained-refund'",
              )
            ).rowCount,
          ).toBe(1);
      },
    );

    it('deletes a user who only created a skill invite', async () => {
      await state.pool!.query(
        "INSERT INTO users(id,phone,created_at) VALUES('review-invite','13000000006',now())",
      );
      await state.pool!.query(
        "INSERT INTO skill_access_invites(id,creator_id,target_type,target_id,token) VALUES('review-invite-row','review-invite','skill','synthetic-skill','synthetic-invite-token')",
      );
      await deleteUser('review-invite');
      expect(
        (
          await state.pool!.query(
            "SELECT 1 FROM skill_access_invites WHERE id='review-invite-row'",
          )
        ).rowCount,
      ).toBe(0);
    });

    it('records concurrent late payment notifications once for reconciliation without crediting another user', async () => {
      await state.pool!.query(
        "INSERT INTO users(id,phone,created_at) VALUES('review-late-payment','13000000007',now())",
      );
      await state.pool!.query(
        "INSERT INTO recharge_orders(id,user_id,trade_id,pay_type,amount_coins) VALUES('late-payment-order','review-late-payment','late-payment-order','alipay',1)",
      );
      await deleteUser('review-late-payment');
      const notify = () =>
        settleRechargeOrderPaid({
          tradeId: 'late-payment-order',
          providerTradeId: 'synthetic-payment',
        });
      const results = await Promise.all([notify(), notify()]);
      for (const result of results)
        expect(result).toMatchObject({
          user_id: null,
          status: 'paid',
          credit_status: 'reconciliation_required',
        });
      expect(
        (
          await state.pool!.query(
            "SELECT 1 FROM wallet_transactions WHERE request_id='late-payment-order'",
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await state.pool!.query(
            "SELECT purchased_coins::float8 AS balance FROM users WHERE id='review-victim'",
          )
        ).rows[0].balance,
      ).toBe(0);
    });

    it('serializes deletion before an arriving payment without a user/order lock inversion', async () => {
      await state.pool!.query(
        "INSERT INTO users(id,phone,created_at) VALUES('review-delete-race','13000000008',now())",
      );
      await state.pool!.query(
        "INSERT INTO recharge_orders(id,user_id,trade_id,pay_type,amount_coins) VALUES('race-order','review-delete-race','race-order','alipay',1)",
      );
      const blocker = await state.pool!.connect();
      const waitForBlocked = async (count: number) => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const result = await state.pool!.query(
            "SELECT count(*)::integer AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
          );
          if (result.rows[0].count >= count) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error('Expected synthetic lock wait was not observed');
      };
      let operations: Promise<unknown> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          "SELECT id FROM users WHERE id='review-delete-race' FOR UPDATE",
        );
        const deletion = deleteUser('review-delete-race');
        await waitForBlocked(1);
        const payment = settleRechargeOrderPaid({ tradeId: 'race-order' });
        operations = Promise.all([deletion, payment]);
        await waitForBlocked(2);
        await blocker.query('COMMIT');
        await operations;
        expect(
          (
            await state.pool!.query(
              "SELECT user_id,status,credit_status FROM recharge_orders WHERE id='race-order'",
            )
          ).rows[0],
        ).toEqual({
          user_id: null,
          status: 'paid',
          credit_status: 'reconciliation_required',
        });
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await operations;
      }
    });

    it.each(['message', 'progress'] as const)(
      'rejects %s from an account inconsistent with the pending request',
      async (type) => {
        state.publish.mockClear();
        const requestId = `review-victim-${type}`;
        const pending = {
          accountId: 'web:review-victim',
          ownerUserId: 'review-victim',
          sessionId: 'review-victim-session',
          autoDeliver: false,
        } as PendingInboxRequest;
        await expect(
          processAiChatOutboxPayload(
            {
              type,
              accountId: 'web:review-attacker',
              requestId,
              text: `Synthetic ${type}`,
            },
            'web:review-attacker',
            new Map([[requestId, pending]]),
          ),
        ).rejects.toThrow('mismatch');
        const row = (
          await state.pool!.query(
            'SELECT account_id,user_id,session_id FROM messages WHERE content LIKE $1',
            [`Synthetic ${type}%`],
          )
        ).rows[0];
        expect(row).toBeUndefined();
        expect(state.publish).not.toHaveBeenCalled();
      },
    );

    it('discards intermediate messages without a live pending request', async () => {
      state.publish.mockClear();
      await processAiChatOutboxPayload(
        {
          type: 'message',
          accountId: 'web:review-attacker',
          requestId: 'review-no-pending',
          sessionId: 'review-victim-session',
          text: 'Synthetic discarded',
        },
        'web:review-attacker',
        new Map(),
      );
      expect(state.publish).not.toHaveBeenCalled();
      expect(
        (
          await state.pool!.query(
            "SELECT 1 FROM messages WHERE content LIKE 'Synthetic discarded%'",
          )
        ).rowCount,
      ).toBe(0);
    });

    it('rejects a final response whose payload account overrides the queue identity', async () => {
      await state.pool!
        .query(`INSERT INTO agent_requests(request_id,execution_id,account_id,session_id,owner_user_id,state,input,runtime,deadline_at)
      VALUES('review-final-request','review-final-execution','web:review-victim','review-victim-session','review-victim','running','{}','{}',now()+interval '1 minute')`);
      await expect(
        processAiChatOutboxPayload(
          {
            type: 'response',
            accountId: 'web:review-victim',
            requestId: 'review-final-request',
            sessionId: 'review-victim-session',
            userMessageId: 'review-victim-user-message',
            ownerUserId: 'review-victim',
            text: 'Synthetic forged final',
            status: 'success',
          },
          'web:review-attacker',
          new Map(),
        ),
      ).rejects.toThrow('mismatch');
      expect(
        (
          await state.pool!.query(
            "SELECT delivered FROM agent_result_deliveries WHERE request_id='review-final-request'",
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await state.pool!.query(
            "SELECT account_id,session_id FROM messages WHERE content LIKE 'Synthetic forged final%'",
          )
        ).rowCount,
      ).toBe(0);
    });

    it('binds a durable final response to its admitted session before logging or settling', async () => {
      await expect(
        processAiChatOutboxPayload(
          {
            type: 'response',
            accountId: 'web:review-victim',
            requestId: 'review-final-request',
            sessionId: 'review-attacker-session',
            ownerUserId: 'review-victim',
            text: 'Synthetic wrong session',
            status: 'success',
          },
          'web:review-victim',
          new Map(),
        ),
      ).rejects.toThrow('context mismatch');
      expect(
        (await state.pool!.query('SELECT 1 FROM conversation_logs')).rowCount,
      ).toBe(0);
    });

    it('enforces session ownership at the message persistence boundary', async () => {
      await expect(
        storeMessage({
          id: 'wrong-session-message',
          account_id: 'web:review-attacker',
          user_id: 'review-attacker',
          sender: 'web:review-attacker',
          content: 'Synthetic wrong owner',
          timestamp: new Date().toISOString(),
          session_id: 'review-victim-session',
        }),
      ).rejects.toThrow('ownership mismatch');
    });

    it('settles an in-flight result after archival while preserving ownership and admission checks', async () => {
      const userId = 'review-archived';
      const accountId = `web:${userId}`;
      const sessionId = 'review-archived-session';
      const nextSessionId = 'review-next-session';
      const requestId = 'review-archived-request';
      await state.pool!.query(`
        INSERT INTO users(id,phone,created_at) VALUES('review-archived','13000000009',now());
        INSERT INTO chat_sessions(id,account_id,user_id,title,model_pool_key) VALUES
          ('review-archived-session','web:review-archived','review-archived','Synthetic','benefit'),
          ('review-next-session','web:review-archived','review-archived','Synthetic','benefit');
        INSERT INTO user_memberships(user_id,plan_key,status,current_period_start,current_period_end)
          VALUES('review-archived','membership','active',now()-interval '1 day',now()+interval '1 day');
      `);
      const runtime: LlmRuntimeSnapshot = {
        ...nodes[0],
        source: 'official',
        billingMode: 'none',
        poolKey: 'benefit',
        benefitPolicy: DEFAULT_BENEFIT_POLICY,
        poolNodes: nodes,
      };
      const admit = (id: string, session: string) =>
        admitAgentRequest({
          requestId: id,
          ownerUserId: userId,
          runtime: { ...runtime, benefitRequestId: id },
          deadlineAt: Date.now() + 60_000,
          input: {
            accountId,
            sessionId: session,
            userMessageId: `message-${id}`,
            userMessage: 'Synthetic question',
            history: [],
          },
        });
      await admit(requestId, sessionId);
      expect(await tryAcquireBenefitExecutionSlot(requestId)).toBe(true);
      await state.pool!.query(
        "UPDATE agent_requests SET state='running' WHERE request_id=$1",
        [requestId],
      );
      await archiveChatSession(sessionId);
      const response = {
        type: 'response',
        requestId,
        accountId,
        ownerUserId: userId,
        sessionId,
        userMessageId: `message-${requestId}`,
        text: 'Synthetic archived reply',
        status: 'success',
      };
      await state.pool!.query(
        "UPDATE agent_requests SET state='result_ready',result=$2 WHERE request_id=$1",
        [requestId, JSON.stringify(response)],
      );

      await processAiChatOutboxPayload(response, accountId, new Map());

      const { rows } = await state.pool!.query(
        `SELECT agent.state AS request_state,benefit.state AS benefit_state,
          usage.reserved_turns,usage.consumed_turns,session.deleted_at IS NOT NULL AS archived
        FROM agent_requests agent JOIN benefit_requests benefit USING(request_id)
        JOIN benefit_daily_usage usage ON usage.user_id=benefit.user_id AND usage.allowance_date=benefit.allowance_date
        JOIN chat_sessions session ON session.id=agent.session_id WHERE agent.request_id=$1`,
        [requestId],
      );
      expect(rows[0]).toEqual({
        request_state: 'completed',
        benefit_state: 'consumed',
        reserved_turns: 0,
        consumed_turns: 1,
        archived: true,
      });
      expect(
        (
          await state.pool!.query(
            'SELECT account_id,user_id,session_id FROM messages WHERE id=$1',
            [`message-${requestId}_reply`],
          )
        ).rows,
      ).toEqual([
        { account_id: accountId, user_id: userId, session_id: sessionId },
      ]);
      for (const identity of [
        { account_id: 'web:review-victim', user_id: userId },
        { account_id: accountId, user_id: 'review-victim' },
      ])
        await expect(
          storeMessage({
            id: 'review-invalid-archived-owner',
            ...identity,
            sender: identity.account_id,
            content: 'Synthetic wrong archived owner',
            timestamp: new Date().toISOString(),
            session_id: sessionId,
          }),
        ).rejects.toThrow('ownership mismatch');
      await expect(
        admit('review-rejected-archived', sessionId),
      ).rejects.toMatchObject({ statusCode: 409 });
      await admit('review-next-request', nextSessionId);
      expect(await tryAcquireBenefitExecutionSlot('review-next-request')).toBe(
        true,
      );
      await deleteUser(userId);
    });

    it('allows only one concurrent legacy execution and external result receipt, including re-enveloped replays', async () => {
      const request = {
        requestId: 'signed-legacy-request',
        accountId: 'web:review-attacker',
        eventId: 'synthetic-first-envelope',
      } as InboxRequest;
      const executions = await Promise.all(
        Array.from({ length: 8 }, () => claimDurableExecution(request)),
      );
      expect(executions.filter(Boolean)).toHaveLength(1);
      expect(
        await claimDurableExecution({
          ...request,
          eventId: 'synthetic-new-envelope',
        } as InboxRequest),
      ).toBe(false);
      const deliveries = await Promise.all(
        Array.from({ length: 8 }, () =>
          claimOutboundIpcReceipt(
            'web:review-attacker',
            'response:signed-legacy-request',
          ),
        ),
      );
      expect(deliveries.filter(Boolean)).toHaveLength(1);
    });
  },
);
