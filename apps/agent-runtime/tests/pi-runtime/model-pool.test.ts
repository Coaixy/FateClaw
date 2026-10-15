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
) {
  const runtime: LlmRuntimeSnapshot = {
    source: 'official',
    billingMode: 'metered',
    ...nodes[0],
    contextWindowTokens: 32_000,
    maxOutputTokens: 1000,
    poolNodes: nodes,
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
    const { complete, store } = await pool(nodes);
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
  });

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
      'failure',
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
    expect(store.finish.mock.calls.map((call) => call[2])).toEqual(['failure']);
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
    const { complete, store } = await pool(
      [node('a', 'http://127.0.0.1:1')],
      health(['a']),
    );
    expect((await complete()).stopReason).toBe('error');
    expect(store.finish).not.toHaveBeenCalled();
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
