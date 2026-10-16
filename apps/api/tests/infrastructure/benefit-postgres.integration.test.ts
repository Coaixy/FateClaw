import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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
  DEFAULT_BENEFIT_POLICY,
  type RuntimeModelPoolNode,
} from '@fateclaw/contracts/model-settings';

const state = vi.hoisted(() => ({ pool: null as pg.Pool | null }));
vi.mock('../../src/infrastructure/db-pool.js', () => ({
  getDbPool: () => state.pool,
}));
vi.mock('../../../agent-runtime/src/agent-db.js', () => ({
  getAgentDbPool: () => state.pool,
}));
import { createPiProviderRuntime } from '../../../agent-runtime/src/pi-runtime/provider.js';
import { installModelPool } from '../../../agent-runtime/src/pi-runtime/model-pool.js';
import {
  claimBenefitTool,
  markBenefitAnswerVisible,
} from '../../../agent-runtime/src/benefit-budget.js';
import { MIGRATIONS } from '../../src/infrastructure/migrations/manifest.js';
import {
  savePlatformModelConfig,
  getPlatformModelSettings,
  getPlatformModelRuntimeSettings,
} from '../../src/infrastructure/repositories/config-repository.js';
import {
  admitAgentRequest,
  withAgentResultDelivery,
} from '../../src/infrastructure/repositories/agent-requests-repository.js';
import {
  settleBenefitTurn,
  tryAcquireBenefitExecutionSlot,
  getBenefitAllowance,
  getBenefitSupply,
  saveModelPoolPreference,
} from '../../src/infrastructure/repositories/benefit-repository.js';
import type { LlmRuntimeSnapshot } from '../../src/runtime/ipc-payloads.js';

// Only this explicitly supplied disposable server is permitted; application credentials are never used.
const connectionString = process.env.FATECLAW_TEST_BENEFIT_DATABASE_URL;
describe.skipIf(!connectionString)('benefit pool durable boundaries', () => {
  let admin: pg.Pool;
  let databaseName: string;
  let nodes: RuntimeModelPoolNode[];
  const policy = { ...DEFAULT_BENEFIT_POLICY };
  const group = {
    id: 'shared-project',
    display_name: 'Synthetic project',
    requests_per_minute: 100,
    requests_per_day: 100,
    tokens_per_minute: 1000000,
    tokens_per_day: 10000000,
    reset_timezone: 'America/Los_Angeles',
    expires_at: null,
    approved: true,
  };
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString });
    databaseName = `fateclaw_benefit_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(connectionString!);
    url.pathname = `/${databaseName}`;
    state.pool = new pg.Pool({ connectionString: url.toString(), max: 10 });
    const db = await state.pool.connect();
    try {
      for (const migration of MIGRATIONS) await migration.up(db);
    } finally {
      db.release();
    }
    await state.pool
      .query(`INSERT INTO users(id,phone,created_at) VALUES('a','13000000001',now()),('b','13000000002',now());
      INSERT INTO chat_sessions(id,account_id,user_id,title,model_pool_key) VALUES('s-a','web:a','a','Synthetic','benefit'),('s-b','web:b','b','Synthetic','benefit')`);
  }, 30000);
  afterAll(async () => {
    await state.pool?.end();
    if (databaseName) await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin?.end();
  });
  beforeEach(async () => {
    await state.pool!
      .query(`UPDATE official_model_pool_settings SET primary_node_id=NULL;
      TRUNCATE benefit_model_attempts,benefit_requests,benefit_daily_usage,agent_result_deliveries,agent_requests;
      DELETE FROM official_model_pool_nodes; DELETE FROM official_model_configs; DELETE FROM benefit_quota_groups;
      DELETE FROM system_secrets; UPDATE official_model_pool_settings SET enabled=false WHERE id='benefit'`);
    await state.pool!.query(
      "UPDATE chat_sessions SET model_pool_key='benefit'",
    );
    await savePlatformModelConfig({
      poolKey: 'benefit',
      displayName: 'Benefits',
      thinkingLevel: 'off',
      enabled: true,
      benefitPolicy: policy,
      quotaGroups: [group],
      inputTokenPricePerMillionCoins: 0,
      outputTokenPricePerMillionCoins: 0,
      nodes: ['one', 'two'].map((name) => ({
        displayName: name,
        piApi: 'openai-completions' as const,
        baseUrl: null,
        modelName: 'synthetic-model',
        secretValue: 'synthetic-provider-value',
        contextWindowTokens: 32000,
        enabled: true,
        weight: 1,
        quotaGroupId: group.id,
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
      quotaGroupId: group.id,
    }));
  });
  async function admit(user = 'a', turns = policy.daily_turns) {
    const id = randomUUID();
    const runtime: LlmRuntimeSnapshot = {
      poolKey: 'benefit',
      benefitPolicy: { ...policy, daily_turns: turns },
      benefitRequestId: id,
      source: 'official',
      billingMode: 'none',
      modelConfigId: 'benefit-model-pool',
      piApi: 'openai-completions',
      model: 'synthetic-model',
      apiKey: 'synthetic-provider-value',
      authMode: 'openai_api_key',
      providerKey: 'benefit',
      poolNodes: nodes,
    };
    await admitAgentRequest({
      requestId: id,
      ownerUserId: user,
      runtime,
      deadlineAt: Date.now() + 210000,
      input: {
        accountId: `web:${user}`,
        sessionId: `s-${user}`,
        userMessage: 'Synthetic question',
        history: [],
      },
    });
    return id;
  }
  async function start(id: string) {
    expect(await tryAcquireBenefitExecutionSlot(id)).toBe(true);
    await state.pool!.query(
      "UPDATE agent_requests SET state='running' WHERE request_id=$1",
      [id],
    );
  }
  async function claim(id: string, node = nodes[0], probe = false) {
    const attempt = randomUUID();
    const { rows } = await state.pool!.query(
      'SELECT claim_benefit_attempt($1,$2,$3,$4,500,300,$5) AS claim',
      [probe ? null : id, node.modelConfigId, node.revision, attempt, probe],
    );
    return rows[0].claim as { benefitAttemptId: string } | null;
  }
  it('fences model changes against active durable requests even if the transient session lock is lost', async () => {
    const id = await admit();
    await expect(
      saveModelPoolPreference('a', 'official', 's-a'),
    ).rejects.toMatchObject({ statusCode: 409 });
    await withAgentResultDelivery(id, 'web:a', async (db) => {
      await settleBenefitTurn(db, id, false);
      return null;
    });
    await saveModelPoolPreference('a', 'official', 's-a');
    const sessions = await state.pool!.query(
      'SELECT id,model_pool_key FROM chat_sessions ORDER BY id',
    );
    expect(sessions.rows).toEqual([
      { id: 's-a', model_pool_key: 'official' },
      { id: 's-b', model_pool_key: 'benefit' },
    ]);
  });
  it('keeps pool membership, public prices and credentials out of metadata independently', async () => {
    const before = await getPlatformModelSettings('benefit');
    await savePlatformModelConfig({
      displayName: 'Paid',
      thinkingLevel: 'medium',
      inputTokenPricePerMillionCoins: 5,
      outputTokenPricePerMillionCoins: 15,
      nodes: [
        {
          displayName: 'Paid node',
          piApi: 'openai-completions',
          baseUrl: null,
          modelName: 'paid-model',
          secretValue: 'synthetic-paid-value',
          contextWindowTokens: 64000,
          enabled: true,
          weight: 1,
        },
      ],
    });
    expect(await getPlatformModelSettings('benefit')).toEqual(before);
    expect((await getPlatformModelSettings()).nodes).toHaveLength(1);
    expect(JSON.stringify(before)).not.toContain('synthetic-provider-value');
    expect(before.pool.input_token_price_per_million_coins).toBe(0);
  });
  it('admits only one concurrent claimant for the last personal turn, atomically with its durable request', async () => {
    const outcomes = await Promise.allSettled([admit('a', 1), admit('a', 1)]);
    expect(
      outcomes.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      (
        await state.pool!.query(
          'SELECT count(*)::integer AS n FROM agent_requests',
        )
      ).rows[0].n,
    ).toBe(1);
    expect((await getBenefitAllowance('a', 1)).remaining_turns).toBe(0);
  });
  it('shares the final upstream request across two model nodes and two resident callers', async () => {
    await state.pool!.query(
      'UPDATE benefit_quota_groups SET requests_per_day=1',
    );
    const a = await admit('a');
    const b = await admit('b');
    await start(a);
    await start(b);
    const results = await Promise.all([claim(a, nodes[0]), claim(b, nodes[1])]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await getBenefitSupply()).toBe('exhausted');
  });
  it('refunds the personal turn without inventing a refund for an ambiguous upstream dispatch', async () => {
    const id = await admit();
    await start(id);
    const attempt = await claim(id);
    expect(attempt).not.toBeNull();
    await state.pool!.query(
      "SELECT settle_benefit_attempt($1,0,0,false,'failure',NULL)",
      [attempt!.benefitAttemptId],
    );
    await withAgentResultDelivery(id, 'web:a', async (db) => {
      expect(await settleBenefitTurn(db, id, false)).toBe('released');
      return null;
    });
    expect((await getBenefitAllowance('a', 3)).remaining_turns).toBe(3);
    const quota = (
      await state.pool!.query(
        'SELECT day_requests,day_tokens FROM benefit_quota_groups',
      )
    ).rows[0];
    expect(quota.day_requests).toBe(1);
    expect(Number(quota.day_tokens)).toBe(800);
    expect(
      (await state.pool!.query('SELECT state FROM benefit_model_attempts'))
        .rows[0].state,
    ).toBe('usage_unknown');
  });
  it('rolls back allowance settlement with failed delivery and makes a successful retry idempotent', async () => {
    const id = await admit();
    await expect(
      withAgentResultDelivery(id, 'web:a', async (db) => {
        await settleBenefitTurn(db, id, true);
        throw new Error('Synthetic delivery failure');
      }),
    ).rejects.toThrow('Synthetic delivery failure');
    expect((await getBenefitAllowance('a', 3)).remaining_turns).toBe(2);
    const deliver = vi.fn(async (db: pg.PoolClient) => {
      await settleBenefitTurn(db, id, true);
      return 'synthetic-reply';
    });
    await withAgentResultDelivery(id, 'web:a', deliver);
    await withAgentResultDelivery(id, 'web:a', deliver);
    expect(deliver).toHaveBeenCalledOnce();
    const day = (
      await state.pool!.query(
        'SELECT consumed_turns,reserved_turns FROM benefit_daily_usage',
      )
    ).rows[0];
    expect(day).toEqual({ consumed_turns: 1, reserved_turns: 0 });
    expect(
      Number(
        (
          await state.pool!.query(
            "SELECT purchased_coins FROM users WHERE id='a'",
          )
        ).rows[0].purchased_coins,
      ),
    ).toBe(0);
  });
  it('bounds monitoring calls across nodes without creating user allowances', async () => {
    for (let index = 0; index < 4; index += 1)
      expect(await claim('', nodes[index % 2], true)).not.toBeNull();
    expect(await claim('', nodes[0], true)).toBeNull();
    expect(
      (
        await state.pool!.query(
          'SELECT count(*)::integer AS n FROM benefit_requests',
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it('grants the final tool execution atomically across concurrent tool calls', async () => {
    const id = await admit();
    await start(id);
    await state.pool!.query(
      `UPDATE benefit_requests SET policy=jsonb_set(policy,'{max_tool_calls}','1') WHERE request_id=$1`,
      [id],
    );
    const runtime = {
      poolKey: 'benefit',
      benefitRequestId: id,
    } as LlmRuntimeSnapshot;
    const results = await Promise.allSettled([
      claimBenefitTool(runtime),
      claimBenefitTool(runtime),
    ]);
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(
      (
        await state.pool!.query(
          'SELECT tool_calls FROM benefit_requests WHERE request_id=$1',
          [id],
        )
      ).rows[0].tool_calls,
    ).toBe(1);
  });
  it('consumes a cancelled turn only after answer text was published', async () => {
    const visible = await admit('a');
    await start(visible);
    await markBenefitAnswerVisible(visible);
    const queued = await admit('b');
    await state.pool!.query(
      'UPDATE agent_requests SET cancel_requested_at=now() WHERE request_id=$1',
      [queued],
    );
    await withAgentResultDelivery(visible, 'web:a', async (db) => {
      expect(await settleBenefitTurn(db, visible, false, true)).toBe(
        'consumed',
      );
      return null;
    });
    await withAgentResultDelivery(queued, 'web:b', async (db) => {
      expect(await settleBenefitTurn(db, queued, true)).toBe('released');
      return null;
    });
    expect((await getBenefitAllowance('a', 3)).remaining_turns).toBe(2);
    expect((await getBenefitAllowance('b', 3)).remaining_turns).toBe(3);
  });

  it('enforces the durable model-call budget on a real local stream and never dispatches a paid fallback', async () => {
    const received: Array<{
      model: string;
      max_tokens?: number;
      max_completion_tokens?: number;
    }> = [];
    const server = createServer((request, response) => {
      let text = '';
      request.on('data', (chunk) => {
        text += chunk;
      });
      request.on('end', () => {
        received.push(JSON.parse(text));
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(
          'data: ' +
            JSON.stringify({
              id: 'synthetic',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'synthetic-model',
              choices: [
                {
                  index: 0,
                  delta: { role: 'assistant', content: 'Synthetic reply' },
                  finish_reason: null,
                },
              ],
            }) +
            '\n\n' +
            'data: ' +
            JSON.stringify({
              id: 'synthetic',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'synthetic-model',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage: {
                prompt_tokens: 20,
                completion_tokens: 5,
                total_tokens: 25,
              },
            }) +
            '\n\ndata: [DONE]\n\n',
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const id = await admit();
      await start(id);
      await state.pool!.query(
        `UPDATE benefit_requests SET policy=jsonb_set(policy,'{max_model_calls}','1') WHERE request_id=$1`,
        [id],
      );
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
      const runtime: LlmRuntimeSnapshot = {
        source: 'official',
        billingMode: 'none',
        poolKey: 'benefit',
        benefitRequestId: id,
        benefitPolicy: policy,
        modelConfigId: 'benefit-model-pool',
        providerKey: 'benefit',
        piApi: 'openai-completions',
        authMode: 'openai_api_key',
        apiKey: 'synthetic-provider-value',
        model: 'synthetic-model',
        baseUrl,
        contextWindowTokens: 32000,
        maxOutputTokens: 2048,
        poolNodes: [
          ...nodes.map((node) => ({ ...node, baseUrl })),
          {
            ...nodes[0],
            poolKey: 'official',
            model: 'must-never-be-called',
            baseUrl,
          },
        ],
      };
      const provider = await createPiProviderRuntime(runtime);
      installModelPool(provider, runtime);
      const context = {
        messages: [
          {
            role: 'user' as const,
            content: 'Synthetic question',
            timestamp: 1,
          },
        ],
      };
      const first = [];
      for await (const event of provider.modelRuntime.streamSimple(
        provider.model,
        context,
      ))
        first.push(event);
      expect(first.at(-1)?.type).toBe('done');
      const second = [];
      for await (const event of provider.modelRuntime.streamSimple(
        provider.model,
        context,
      ))
        second.push(event);
      expect(second.at(-1)?.type).toBe('error');
      expect(received).toHaveLength(1);
      expect(received[0].model).toBe('synthetic-model');
      expect(
        received[0].max_completion_tokens ?? received[0].max_tokens,
      ).toBeLessThanOrEqual(2048);
      expect(
        (
          await state.pool!.query(
            'SELECT answer_visible FROM benefit_requests WHERE request_id=$1',
            [id],
          )
        ).rows[0].answer_visible,
      ).toBe(true);
      expect(
        Number(
          (
            await state.pool!.query(
              'SELECT day_tokens FROM benefit_quota_groups',
            )
          ).rows[0].day_tokens,
        ),
      ).toBe(25);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it('preserves spent capacity across admin saves and resets only the provider window', async () => {
    const id = await admit();
    await start(id);
    expect(await claim(id)).not.toBeNull();
    const before = await getPlatformModelSettings('benefit');
    await savePlatformModelConfig({
      poolKey: 'benefit',
      revision: before.pool.revision,
      displayName: 'Renamed benefits',
      thinkingLevel: 'off',
      enabled: true,
      benefitPolicy: policy,
      quotaGroups: [group],
      inputTokenPricePerMillionCoins: 0,
      outputTokenPricePerMillionCoins: 0,
      nodes: before.nodes.map((entry) => ({
        id: entry.model.id,
        displayName: entry.model.display_name,
        piApi: entry.model.pi_api,
        baseUrl: null,
        modelName: entry.model.model_name,
        contextWindowTokens: 32000,
        enabled: true,
        weight: 2,
        quotaGroupId: group.id,
      })),
    });
    expect(
      (await state.pool!.query('SELECT day_requests FROM benefit_quota_groups'))
        .rows[0].day_requests,
    ).toBe(1);
    await state.pool!.query(
      "UPDATE benefit_quota_groups SET day_start=day_start-interval '1 day',day_requests=requests_per_day",
    );
    expect(await claim(id)).not.toBeNull();
    const reset = await state.pool!.query(
      "SELECT day_requests,day_start=date_trunc('day',now() AT TIME ZONE reset_timezone) AT TIME ZONE reset_timezone AS correct FROM benefit_quota_groups",
    );
    expect(reset.rows[0]).toEqual({ day_requests: 1, correct: true });
  });
});
