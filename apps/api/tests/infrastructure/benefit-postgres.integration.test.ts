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
import { probeBenefitModelAvailability } from '../../src/modules/system/model-availability-probe.js';
import {
  recordBenefitToolCall,
  markBenefitAnswerVisible,
} from '../../../agent-runtime/src/benefit-execution.js';
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
  getPreferredModelPool,
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
      TRUNCATE benefit_model_attempts,benefit_requests,benefit_daily_usage,agent_result_deliveries,agent_requests,user_model_preferences;
      DELETE FROM official_model_pool_nodes; DELETE FROM official_model_configs;
      DELETE FROM system_secrets; UPDATE official_model_pool_settings SET enabled=false WHERE id='benefit'`);
    await state.pool!.query(
      "UPDATE chat_sessions SET model_pool_key='benefit'",
    );
    await state.pool!.query(`DELETE FROM user_memberships;
      INSERT INTO user_memberships(user_id,plan_key,status,current_period_start,current_period_end)
      SELECT id,'membership','active',now()-interval '1 day',now()+interval '1 day' FROM users`);
    await savePlatformModelConfig({
      poolKey: 'benefit',
      displayName: 'Benefits',
      thinkingLevel: 'off',
      enabled: true,
      benefitPolicy: policy,
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
      'SELECT claim_benefit_attempt($1,$2,$3,$4,$5) AS claim',
      [probe ? null : id, node.modelConfigId, node.revision, attempt, probe],
    );
    return rows[0].claim as { benefitAttemptId: string } | null;
  }
  it.each([false, true])(
    'defaults new conversations to paid models when the free service is enabled=%s',
    async (enabled) => {
      await state.pool!.query(
        "UPDATE official_model_pool_settings SET enabled=$1 WHERE id='benefit'",
        [enabled],
      );
      expect(await getPreferredModelPool('a')).toBe('official');
    },
  );
  it.each(['official', 'benefit'] as const)(
    'preserves an explicit %s preference for new conversations',
    async (poolKey) => {
      await saveModelPoolPreference('a', poolKey);
      expect(await getPreferredModelPool('a')).toBe(poolKey);
    },
  );
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
  it.each(['missing', 'expired', 'cancelled'])(
    'rejects a free request with %s membership without reserving a turn or admitting a request',
    async (membership) => {
      if (membership === 'missing') {
        await state.pool!.query(
          "DELETE FROM user_memberships WHERE user_id='a'",
        );
      } else {
        await state.pool!.query(
          membership === 'expired'
            ? "UPDATE user_memberships SET current_period_end=now()-interval '1 second' WHERE user_id='a'"
            : "UPDATE user_memberships SET status='cancelled' WHERE user_id='a'",
        );
      }
      await expect(admit()).rejects.toMatchObject({ statusCode: 403 });
      expect(
        (await state.pool!.query('SELECT 1 FROM agent_requests')).rowCount,
      ).toBe(0);
      expect(
        (await state.pool!.query('SELECT 1 FROM benefit_requests')).rowCount,
      ).toBe(0);
      expect(
        (await state.pool!.query('SELECT 1 FROM benefit_daily_usage')).rowCount,
      ).toBe(0);
    },
  );
  it('finishes an admitted free request after membership expires while rejecting new requests', async () => {
    const id = await admit();
    await state.pool!.query(
      "UPDATE user_memberships SET current_period_end=now()-interval '1 second' WHERE user_id='a'",
    );
    expect(await tryAcquireBenefitExecutionSlot(id)).toBe(true);
    await withAgentResultDelivery(id, 'web:a', async (db) => {
      expect(await settleBenefitTurn(db, id, true)).toBe('consumed');
      return null;
    });
    expect(
      (await getBenefitAllowance('a', policy.daily_turns)).remaining_turns,
    ).toBe(policy.daily_turns - 1);
    await expect(admit()).rejects.toMatchObject({ statusCode: 403 });
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
  it('admits a remaining daily turn regardless of accumulated token usage', async () => {
    await state.pool!
      .query(`INSERT INTO benefit_daily_usage(user_id,allowance_date,input_tokens,output_tokens)
      VALUES('a',(now() AT TIME ZONE 'Asia/Shanghai')::date,1000000,1000000)`);
    expect((await getBenefitAllowance('a', 3)).remaining_turns).toBe(3);
    await admit();
    expect((await getBenefitAllowance('a', 3)).remaining_turns).toBe(2);
  });
  it('keeps the free execution concurrency boundary and releases a slot after settlement', async () => {
    const first = await admit('a');
    const second = await admit('b');
    await state.pool!.query(
      `UPDATE benefit_requests SET policy=jsonb_set(policy,'{concurrency_limit}','1')`,
    );
    const acquired = await Promise.all([
      tryAcquireBenefitExecutionSlot(first),
      tryAcquireBenefitExecutionSlot(second),
    ]);
    expect(acquired).toEqual([true, false]);
    await withAgentResultDelivery(first, 'web:a', async (db) => {
      await settleBenefitTurn(db, first, false);
      return null;
    });
    expect(await tryAcquireBenefitExecutionSlot(second)).toBe(true);
  });
  it('uses provider cooldowns independently across nodes and leases one recovery attempt', async () => {
    const id = await admit();
    await start(id);
    const attempt = await claim(id);
    await state.pool!.query(
      "SELECT settle_benefit_attempt($1,0,0,false,'failure',120,'rate_limit')",
      [attempt!.benefitAttemptId],
    );
    expect(await claim(id)).toBeNull();
    expect(await claim(id, nodes[1])).not.toBeNull();
    expect(await getBenefitSupply()).toBe('available');
    await state.pool!.query(
      "UPDATE official_model_pool_nodes SET cooldown_until=now()-interval '1 second' WHERE model_config_id=$1",
      [nodes[0].modelConfigId],
    );
    const probes = await Promise.all([
      claim('', nodes[0], true),
      claim('', nodes[0], true),
    ]);
    expect(probes.filter(Boolean)).toHaveLength(1);
    await state.pool!.query(
      "SELECT settle_benefit_attempt($1,0,0,false,'success')",
      [probes.find(Boolean)!.benefitAttemptId],
    );
    const health = await state.pool!.query(
      'SELECT failure_count,cooldown_until,cooldown_reason,probe_token FROM official_model_pool_nodes WHERE model_config_id=$1',
      [nodes[0].modelConfigId],
    );
    expect(health.rows[0]).toEqual({
      failure_count: 0,
      cooldown_until: null,
      cooldown_reason: null,
      probe_token: null,
    });
    expect(await claim('', nodes[0], true)).not.toBeNull();
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
    const usage = (
      await state.pool!.query(
        'SELECT input_tokens,output_tokens FROM benefit_requests WHERE request_id=$1',
        [id],
      )
    ).rows[0];
    expect(usage).toEqual({ input_tokens: '0', output_tokens: '0' });
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
  it('skips monitoring calls while a node is cooling without creating user allowances', async () => {
    const attempt = await claim('', nodes[0], true);
    expect(attempt).not.toBeNull();
    await state.pool!.query(
      "SELECT settle_benefit_attempt($1,0,0,false,'failure',3600,'quota')",
      [attempt!.benefitAttemptId],
    );
    expect(await claim('', nodes[0], true)).toBeNull();
    expect(await claim('', nodes[1], true)).not.toBeNull();
    expect(
      (
        await state.pool!.query(
          'SELECT count(*)::integer AS n FROM benefit_requests',
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it('records tool executions beyond the former cap and rejects executions after cancellation', async () => {
    const id = await admit();
    await start(id);
    const runtime = {
      poolKey: 'benefit',
      benefitRequestId: id,
    } as LlmRuntimeSnapshot;
    await Promise.all(
      Array.from({ length: 5 }, () => recordBenefitToolCall(runtime)),
    );
    expect(
      (
        await state.pool!.query(
          'SELECT tool_calls FROM benefit_requests WHERE request_id=$1',
          [id],
        )
      ).rows[0].tool_calls,
    ).toBe(5);
    await state.pool!.query(
      'UPDATE agent_requests SET cancel_requested_at=now() WHERE request_id=$1',
      [id],
    );
    await expect(recordBenefitToolCall(runtime)).rejects.toThrow(
      '免费请求已取消或结束',
    );
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

  it.each([
    {
      status: 429,
      message: 'rate limit exceeded',
      retry: '123',
      seconds: 123,
      reason: 'rate_limit',
    },
    {
      status: 429,
      message: 'daily quota exceeded',
      retry: undefined,
      seconds: 3600,
      reason: 'quota',
    },
    {
      status: 402,
      message: 'insufficient balance',
      retry: 'invalid',
      seconds: 3600,
      reason: 'quota',
    },
    {
      status: 429,
      message: 'rate limit exceeded',
      retry: new Date(Date.now() + 180_000).toUTCString(),
      seconds: 180,
      reason: 'rate_limit',
    },
  ])(
    'cools an upstream $status $message response and skips it on the next model call',
    async ({ status, message, retry, seconds, reason }) => {
      const calls: string[] = [];
      const server = createServer((request, response) => {
        calls.push(request.url!);
        if (request.url!.startsWith('/limited/')) {
          response.writeHead(status, {
            'content-type': 'application/json',
            ...(retry ? { 'retry-after': retry } : {}),
          });
          response.end(JSON.stringify({ error: { message } }));
        } else {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Synthetic reply' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })}\n\ndata: [DONE]\n\n`,
          );
        }
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      try {
        const id = await admit();
        await start(id);
        const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const runtime: LlmRuntimeSnapshot = {
          ...nodes[0],
          source: 'official',
          billingMode: 'none',
          poolKey: 'benefit',
          benefitRequestId: id,
          benefitPolicy: policy,
          contextWindowTokens: 32000,
          poolNodes: nodes.map((node, index) => ({
            ...node,
            baseUrl: `${baseUrl}/${index ? 'healthy' : 'limited'}/v1`,
          })),
        };
        const provider = await createPiProviderRuntime(runtime);
        installModelPool(provider, runtime, { random: () => 0 });
        const complete = () =>
          provider.modelRuntime.completeSimple(provider.model, {
            messages: [
              { role: 'user', content: 'Synthetic question', timestamp: 1 },
            ],
          });
        expect((await complete()).stopReason).toBe('stop');
        expect((await complete()).stopReason).toBe('stop');
        expect(calls).toEqual([
          '/limited/v1/chat/completions',
          '/healthy/v1/chat/completions',
          '/healthy/v1/chat/completions',
        ]);
        const health = (
          await state.pool!.query(
            'SELECT cooldown_reason,EXTRACT(EPOCH FROM cooldown_until-now())::float8 AS seconds FROM official_model_pool_nodes WHERE model_config_id=$1',
            [nodes[0].modelConfigId],
          )
        ).rows[0];
        expect(health.cooldown_reason).toBe(reason);
        expect(health.seconds).toBeGreaterThan(seconds - 10);
        expect(health.seconds).toBeLessThanOrEqual(seconds);
        // Monitoring uses the same node lease and must not spend another call during cooldown.
        expect(
          await probeBenefitModelAvailability(
            runtime.poolNodes![0],
            new AbortController().signal,
          ),
        ).toEqual({ latency: null, attempted: false });
        expect(calls).toHaveLength(3);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it('applies provider feedback from scheduled monitoring to the node cooldown', async () => {
    let calls = 0;
    const server = createServer((_request, response) => {
      calls += 1;
      response.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': '240',
      });
      response.end(
        JSON.stringify({ error: { message: 'rate limit exceeded' } }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const node = {
        ...nodes[0],
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      };
      const signal = new AbortController().signal;
      expect(await probeBenefitModelAvailability(node, signal)).toEqual({
        latency: null,
        attempted: true,
      });
      expect(await probeBenefitModelAvailability(node, signal)).toEqual({
        latency: null,
        attempted: false,
      });
      expect(calls).toBe(1);
      const health = (
        await state.pool!.query(
          'SELECT cooldown_reason,EXTRACT(EPOCH FROM cooldown_until-now())::float8 AS seconds FROM official_model_pool_nodes WHERE model_config_id=$1',
          [node.modelConfigId],
        )
      ).rows[0];
      expect(health.cooldown_reason).toBe('rate_limit');
      expect(health.seconds).toBeGreaterThan(235);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('uses ordinary input and output capacity across repeated free calls without dispatching a paid fallback', async () => {
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
        maxOutputTokens: 8192,
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
      installModelPool(provider, runtime, {
        answerSessionId: 'synthetic-answer-session',
      });
      const context = {
        systemPrompt: 'Synthetic context '.repeat(1500),
        messages: [
          {
            role: 'user' as const,
            content: 'Synthetic question',
            timestamp: 1,
          },
        ],
      };
      const summary = await provider.modelRuntime.completeSimple(
        provider.model,
        context,
        { sessionId: 'synthetic-compaction-session' },
      );
      expect(summary.stopReason).toBe('stop');
      expect(
        (
          await state.pool!.query(
            'SELECT answer_visible FROM benefit_requests WHERE request_id=$1',
            [id],
          )
        ).rows[0].answer_visible,
      ).toBe(false);
      await state.pool!.query(
        'UPDATE agent_requests SET cancel_requested_at=now() WHERE request_id=$1',
        [id],
      );
      await withAgentResultDelivery(id, 'web:a', async (db) => {
        expect(await settleBenefitTurn(db, id, false, true)).toBe('released');
        return null;
      });
      expect((await getBenefitAllowance('a', 3)).remaining_turns).toBe(3);
      const answerRequestId = await admit('b');
      await start(answerRequestId);
      installModelPool(
        provider,
        { ...runtime, benefitRequestId: answerRequestId },
        { answerSessionId: 'synthetic-answer-session' },
      );
      for (let call = 0; call < 5; call += 1) {
        const result = await provider.modelRuntime.completeSimple(
          provider.model,
          context,
          { sessionId: 'synthetic-answer-session' },
        );
        expect(result.stopReason).toBe('stop');
      }
      expect(received).toHaveLength(6);
      for (const request of received) {
        expect(request.model).toBe('synthetic-model');
        expect(request.max_completion_tokens ?? request.max_tokens).toBe(8192);
      }
      expect(
        (
          await state.pool!.query(
            'SELECT answer_visible FROM benefit_requests WHERE request_id=$1',
            [answerRequestId],
          )
        ).rows[0].answer_visible,
      ).toBe(true);
      expect(
        Number(
          (
            await state.pool!.query(
              'SELECT sum(input_tokens+output_tokens) AS tokens FROM benefit_model_attempts',
            )
          ).rows[0].tokens,
        ),
      ).toBe(150);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it('preserves node cooldowns and personal usage across unrelated admin saves', async () => {
    const id = await admit();
    await start(id);
    const attempt = await claim(id);
    await state.pool!.query(
      "SELECT settle_benefit_attempt($1,0,0,false,'failure',3600,'quota')",
      [attempt!.benefitAttemptId],
    );
    await state.pool!.query(
      'UPDATE official_model_configs SET enabled=false WHERE id=$1',
      [nodes[1].modelConfigId],
    );
    expect(await getBenefitSupply()).toBe('exhausted');
    const before = await getPlatformModelSettings('benefit');
    await savePlatformModelConfig({
      poolKey: 'benefit',
      revision: before.pool.revision,
      displayName: 'Renamed benefits',
      thinkingLevel: 'off',
      enabled: true,
      benefitPolicy: policy,
      inputTokenPricePerMillionCoins: 0,
      outputTokenPricePerMillionCoins: 0,
      nodes: before.nodes.map((entry) => ({
        id: entry.model.id,
        displayName: entry.model.display_name,
        piApi: entry.model.pi_api,
        baseUrl: null,
        modelName: entry.model.model_name,
        contextWindowTokens: 32000,
        enabled: entry.model.enabled,
        weight: 2,
      })),
    });
    expect(await claim(id)).toBeNull();
    expect(await getBenefitSupply()).toBe('exhausted');
    const usage = (
      await state.pool!.query(
        'SELECT model_calls,input_tokens,output_tokens FROM benefit_requests WHERE request_id=$1',
        [id],
      )
    ).rows[0];
    expect(usage).toEqual({
      model_calls: 1,
      input_tokens: '0',
      output_tokens: '0',
    });
  });
});
