import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeModelPoolNode } from '@fateclaw/contracts/model-settings';
import type { LlmRuntimeSnapshot } from '../../src/types.js';
import { createPiProviderRuntime } from '../../src/pi-runtime/provider.js';
import {
  installModelPool,
  weightedNodeOrder,
} from '../../src/pi-runtime/model-pool.js';
import type { ModelPoolHealthStore } from '../../src/model-pool-health.js';
import { createRequestScope } from '../../src/request-scope.js';
import { traceEvent } from '../../src/trace.js';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
});
async function serve(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing test server');
  return `http://127.0.0.1:${address.port}/v1`;
}
function sse(response: ServerResponse, payload: unknown) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}
function reply(response: ServerResponse, text = 'Backup answer') {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  sse(response, {
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', content: text },
        finish_reason: null,
      },
    ],
  });
  sse(response, {
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
  });
  response.end('data: [DONE]\n\n');
}
function node(id: string, baseUrl: string, weight = 1): RuntimeModelPoolNode {
  return {
    modelConfigId: id,
    revision: 1,
    weight,
    piApi: 'openai-completions',
    model: `model-${id}`,
    providerKey: `provider-${id}`,
    authMode: 'openai_api_key',
    apiKey: `synthetic-key-${id}`,
    baseUrl,
  };
}
function health(
  skipped: string[] = [],
): ModelPoolHealthStore & { finish: ReturnType<typeof vi.fn> } {
  return {
    claim: vi.fn(async (node) =>
      skipped.includes(node.modelConfigId)
        ? null
        : { generation: 0, token: null },
    ),
    finish: vi.fn(async () => {}),
  };
}
async function pool(
  nodes: RuntimeModelPoolNode[],
  store = health(),
  options: Parameters<typeof installModelPool>[2] = {},
  runtimeOverrides: Partial<LlmRuntimeSnapshot> = {},
) {
  const runtime: LlmRuntimeSnapshot = {
    source: 'official',
    billingMode: 'metered',
    ...nodes[0],
    contextWindowTokens: 32_000,
    maxOutputTokens: 1000,
    poolNodes: nodes,
    ...runtimeOverrides,
  };
  const provider = await createPiProviderRuntime(runtime);
  installModelPool(provider, runtime, {
    health: store,
    random: () => 0,
    ...options,
  });
  return {
    provider,
    store,
    complete: (signal?: AbortSignal) =>
      provider.modelRuntime.completeSimple(
        provider.model,
        {
          messages: [
            { role: 'user', content: 'Synthetic question', timestamp: 1 },
          ],
        },
        { signal, apiKey: 'synthetic-representative-key' },
      ),
  };
}

describe('model pool transport', () => {
  it('fails over a 503 to a different model using only the selected node credential and one attempt per node', async () => {
    const calls: string[] = [];
    const failed = await serve((request, response) => {
      calls.push(request.headers.authorization!);
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end('{"error":{"message":"synthetic unavailable"}}');
    });
    const backup = await serve((request, response) => {
      calls.push(request.headers.authorization!);
      reply(response);
    });
    const nodes = [node('a', failed), node('b', backup)];
    const trace = vi.fn();
    const { complete, store } = await pool(nodes, health(), { trace });
    const result = await complete();
    expect(result.stopReason).toBe('stop');
    expect(result.model).toBe('model-b');
    expect(result.content).toEqual([{ type: 'text', text: 'Backup answer' }]);
    expect(result.usage).toMatchObject({
      input: 11,
      output: 3,
      totalTokens: 14,
    });
    expect(calls).toEqual(['Bearer synthetic-key-a', 'Bearer synthetic-key-b']);
    expect(store.finish.mock.calls.map((call) => call[2])).toEqual([
      'failure',
      'success',
    ]);
    expect(trace).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'model_pool_attempt_completed',
        level: 'warn',
        nodeId: 'a',
        provider: 'openai-completions',
        providerKey: 'provider-a',
        model: 'model-a',
        statusCode: 503,
        durationMs: expect.any(Number),
        error: expect.objectContaining({
          message: expect.stringContaining('synthetic unavailable'),
        }),
      }),
    );
  });

  it.each(['official', 'benefit'] as const)(
    'logs a %s pool authentication failure with request context and redacted provider details',
    async (poolKey) => {
      const failed = await serve((_request, response) => {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            error: {
              message:
                'invalid api key synthetic-key-a at https://synthetic.example/v1; secondary synthetic-key-b',
            },
          }),
        );
      });
      const nodes = [node('a', failed), node('b', failed)].map((entry) => ({
        ...entry,
        poolKey,
      }));
      const scope = createRequestScope();
      scope.requestId = 'synthetic-request';
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      try {
        const { complete } = await pool(
          nodes,
          health(),
          {
            trace: (event) => traceEvent(event, scope),
          },
          {
            poolKey,
            ...(poolKey === 'benefit'
              ? { billingMode: 'none', benefitRequestId: 'synthetic-request' }
              : {}),
          },
        );
        const result = await complete();
        expect(result.stopReason).toBe('error');
        expect(result.errorMessage).toContain('上游服务认证失败');
        expect(result).toMatchObject({
          modelFailure: { kinds: ['authentication'] },
        });
        expect(result.errorMessage).not.toContain('invalid api key');
        expect(scope.traceEvents).toContainEqual(
          expect.objectContaining({
            type: 'model_pool_attempt_completed',
            level: 'warn',
            requestId: 'synthetic-request',
            poolKey,
            nodeId: 'a',
            statusCode: 401,
            error: expect.objectContaining({
              message: expect.stringContaining('invalid api key [已脱敏]'),
            }),
          }),
        );
        expect(scope.traceEvents).toContainEqual(
          expect.objectContaining({
            type: 'model_pool_exhausted',
            level: 'error',
            reason: 'all_attempts_failed',
            attemptedNodeIds: ['a', 'b'],
            skippedNodeIds: [],
          }),
        );
        const written = stderr.mock.calls
          .map(([chunk]) => String(chunk))
          .join('');
        expect(written).toContain('[trace:warn] ');
        expect(written).toContain('[trace:error] ');
        expect(written).toContain('invalid api key');
        expect(written).not.toContain('synthetic-key-a');
        expect(written).not.toContain('synthetic-key-b');
        expect(written).not.toContain('synthetic.example');
        expect(JSON.stringify(scope.traceEvents)).not.toContain(
          'synthetic-key-',
        );
      } finally {
        stderr.mockRestore();
      }
    },
  );

  it('preserves a transport failure cause and fails over before SDK normalization hides it', async () => {
    const trace = vi.fn();
    const backup = await serve((_request, response) => reply(response));
    const { provider } = await pool(
      [node('a', 'https://synthetic.example/v1'), node('b', backup)],
      health(),
      { trace },
    );
    const result = await provider.modelRuntime.completeSimple(
      provider.model,
      { messages: [] },
      {
        apiKey: 'synthetic-representative-key',
        fetch: async (input, init) => {
          if (String(input).startsWith('https://synthetic.example/')) {
            throw new TypeError('fetch failed', {
              cause: Object.assign(new Error('connect ECONNREFUSED'), {
                code: 'ECONNREFUSED',
              }),
            });
          }
          return globalThis.fetch(input, init);
        },
      },
    );
    expect(result.stopReason).toBe('stop');
    expect(result.model).toBe('model-b');
    expect(trace).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'model_pool_attempt_completed',
        level: 'warn',
        outcome: 'local_failure',
        error: expect.objectContaining({
          name: 'TypeError',
          message: 'fetch failed',
          cause: expect.objectContaining({
            code: 'ECONNREFUSED',
            message: 'connect ECONNREFUSED',
          }),
        }),
      }),
    );
  });

  it.each(['official', 'benefit'] as const)(
    'preserves a shared-provider rate limit after exhausting the %s pool',
    async (poolKey) => {
      const failed = await serve((_request, response) => {
        response.writeHead(429, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            error: {
              code: 429,
              message: 'Provider returned error',
              metadata: {
                limit_source: 'upstream_provider_shared_pool',
                raw: 'Synthetic model is temporarily rate-limited upstream',
              },
            },
          }),
        );
      });
      const nodes = [node('a', failed), node('b', failed)].map((entry) => ({
        ...entry,
        poolKey,
      }));
      const { complete } = await pool(
        nodes,
        health(),
        {},
        {
          poolKey,
          ...(poolKey === 'benefit'
            ? { billingMode: 'none', benefitRequestId: 'synthetic-request' }
            : {}),
        },
      );
      const result = await complete();
      expect(result.errorMessage).toContain('共享');
      expect(result.errorMessage).toContain('限流');
      expect(result).toMatchObject({
        modelFailure: { kinds: ['shared_pool_rate_limit'] },
      });
    },
  );

  it('summarizes different failed channels instead of reporting only the last error', async () => {
    const failed = await serve((request, response) => {
      const status =
        request.headers.authorization === 'Bearer synthetic-key-a' ? 401 : 503;
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end('{"error":{"message":"Synthetic provider error"}}');
    });
    const { complete } = await pool([node('a', failed), node('b', failed)]);
    const result = await complete();
    expect(result.errorMessage).toContain('认证失败');
    expect(result.errorMessage).toContain('服务故障');
    expect(result).toMatchObject({
      modelFailure: { kinds: ['authentication', 'unavailable'] },
    });
  });

  it.each(['claim', 'health_update'] as const)(
    'reports %s error codes without logging database values',
    async (phase) => {
      const store = health();
      const databaseError = Object.assign(
        new Error('synthetic private database value'),
        { code: '08006' },
      );
      if (phase === 'claim')
        vi.mocked(store.claim).mockRejectedValueOnce(databaseError);
      else store.finish.mockRejectedValueOnce(databaseError);
      const trace = vi.fn();
      const baseUrl = await serve((_request, response) => reply(response));
      const { complete } = await pool([node('a', baseUrl)], store, { trace });
      expect((await complete()).stopReason).toBe(
        phase === 'claim' ? 'error' : 'stop',
      );
      expect(trace).toHaveBeenCalledWith(
        expect.objectContaining({
          type:
            phase === 'claim'
              ? 'model_pool_error'
              : 'model_pool_health_update_failed',
          level: phase === 'claim' ? 'error' : 'warn',
          ...(phase === 'claim' ? { phase: 'claim' } : {}),
          nodeId: 'a',
          error: expect.objectContaining({ name: 'Error', code: '08006' }),
        }),
      );
      expect(JSON.stringify(trace.mock.calls)).not.toContain(
        'synthetic private database value',
      );
    },
  );

  it('skips a cooling or revised node without contacting its endpoint', async () => {
    const contacted = vi.fn(
      (_request: IncomingMessage, response: ServerResponse) => reply(response),
    );
    const baseUrl = await serve(contacted);
    const { complete } = await pool(
      [node('cooling', baseUrl), node('ready', baseUrl)],
      health(['cooling']),
    );
    expect((await complete()).model).toBe('model-ready');
    expect(contacted).toHaveBeenCalledOnce();
  });

  it('includes reported usage from an empty failed response in the successful backup result', async () => {
    const empty = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      sse(response, {
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 0, total_tokens: 7 },
      });
      response.end('data: [DONE]\n\n');
    });
    const ready = await serve((_request, response) => reply(response));
    const { complete } = await pool([node('a', empty), node('b', ready)]);
    expect((await complete()).usage).toMatchObject({
      input: 18,
      output: 3,
      totalTokens: 21,
    });
  });

  it('switches between OpenAI and Anthropic protocols with the backup model and its authentication', async () => {
    const failed = await serve((_request, response) => {
      response.writeHead(502);
      response.end('synthetic unavailable');
    });
    let authentication: string | undefined;
    const backup = await serve((request, response) => {
      authentication = request.headers['x-api-key'] as string | undefined;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (type: string, data: object) =>
        response.write(
          `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
        );
      emit('message_start', {
        message: {
          id: 'msg_synthetic',
          type: 'message',
          role: 'assistant',
          model: 'model-b',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 11, output_tokens: 0 },
        },
      });
      emit('content_block_start', {
        index: 0,
        content_block: { type: 'text', text: '' },
      });
      emit('content_block_delta', {
        index: 0,
        delta: { type: 'text_delta', text: 'Anthropic backup' },
      });
      emit('content_block_stop', { index: 0 });
      emit('message_delta', {
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 3 },
      });
      emit('message_stop', {});
      response.end();
    });
    const { complete } = await pool([
      node('a', failed),
      {
        ...node('b', backup),
        piApi: 'anthropic-messages',
        authMode: 'anthropic_api_key',
      },
    ]);
    const result = await complete();
    expect(result.stopReason).toBe('stop');
    expect(result.content).toEqual([
      { type: 'text', text: 'Anthropic backup' },
    ]);
    expect(result.usage.totalTokens).toBe(14);
    expect(authentication).toBe('synthetic-key-b');
  });

  it('switches away from a provider that never sends content within the first-content deadline', async () => {
    const stalled = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
    });
    const ready = await serve((_request, response) => reply(response));
    const { complete, store } = await pool(
      [node('a', stalled), node('b', ready)],
      health(),
      { firstContentTimeoutMs: 40 },
    );
    expect((await complete()).model).toBe('model-b');
    expect(store.finish.mock.calls.map((call) => call[2])).toEqual([
      'release',
      'success',
    ]);
  });

  it('terminates a stalled stream after content instead of replaying the model call', async () => {
    const first = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      sse(response, {
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'Already visible' },
            finish_reason: null,
          },
        ],
      });
    });
    const backup = vi.fn(
      (_request: IncomingMessage, response: ServerResponse) => reply(response),
    );
    const next = await serve(backup);
    const { complete, store } = await pool(
      [node('a', first), node('b', next)],
      health(),
      { idleTimeoutMs: 40 },
    );
    expect(await complete()).toMatchObject({
      stopReason: 'error',
      errorMessage: expect.stringContaining('超时'),
    });
    expect(backup).not.toHaveBeenCalled();
    expect(store.finish.mock.calls.map((call) => call[2])).toEqual(['release']);
  });

  it('does not fail over or penalize nodes when the caller cancels', async () => {
    const controller = new AbortController();
    const first = await serve((_request, response) => {
      response.writeHead(200);
      response.flushHeaders();
      controller.abort();
    });
    const backup = vi.fn(
      (_request: IncomingMessage, response: ServerResponse) => reply(response),
    );
    const next = await serve(backup);
    const { complete, store } = await pool([node('a', first), node('b', next)]);
    expect((await complete(controller.signal)).stopReason).toBe('aborted');
    expect(backup).not.toHaveBeenCalled();
    expect(store.finish.mock.calls.map((call) => call[2])).toEqual(['release']);
  });

  it('returns input errors without cooling a supplier or repeating the same invalid request', async () => {
    const first = await serve((_request, response) => {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end('{"error":{"message":"maximum context length exceeded"}}');
    });
    const backup = vi.fn(
      (_request: IncomingMessage, response: ServerResponse) => reply(response),
    );
    const next = await serve(backup);
    const { complete, store } = await pool([node('a', first), node('b', next)]);
    expect(await complete()).toMatchObject({
      stopReason: 'error',
      errorMessage: expect.stringContaining('消息内容过长'),
    });
    expect(backup).not.toHaveBeenCalled();
    expect(store.finish.mock.calls.map((call) => call[2])).toEqual(['release']);
  });

  it('fails finitely when all nodes are cooling', async () => {
    const trace = vi.fn();
    const { complete, store } = await pool(
      [node('a', 'http://127.0.0.1:1')],
      health(['a']),
      { trace },
    );
    const result = await complete();
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toContain('没有可用的模型通道');
    expect(result.errorMessage).not.toContain('限流');
    expect(store.finish).not.toHaveBeenCalled();
    expect(trace).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'model_pool_node_skipped',
        nodeId: 'a',
        reason: 'claim_denied',
      }),
    );
    expect(trace).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'model_pool_exhausted',
        level: 'error',
        reason: 'no_claimable_nodes',
        attemptedNodeIds: [],
        skippedNodeIds: ['a'],
      }),
    );
  });
});

describe('weighted pool selection', () => {
  it('implements the exact weight proportions and never repeats a node within a call', () => {
    const nodes = [
      node('a', 'https://a.example', 3),
      node('b', 'https://b.example', 1),
    ];
    let firstCount = 0;
    for (let index = 0; index < 1000; index += 1) {
      const order = weightedNodeOrder(nodes, () => (index + 0.5) / 1000);
      if (order[0].modelConfigId === 'a') firstCount += 1;
      expect(new Set(order.map((entry) => entry.modelConfigId)).size).toBe(2);
    }
    expect(firstCount).toBe(750);
  });
});
