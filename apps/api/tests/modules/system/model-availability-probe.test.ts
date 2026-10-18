import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeModelPoolNode } from '@fateclaw/contracts/model-settings';
import { probeModelAvailability } from '#modules/system/model-availability-probe';
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
    throw new Error('Missing test address');
  return `http://127.0.0.1:${address.port}`;
}
function node(
  baseUrl: string,
  piApi: RuntimeModelPoolNode['piApi'] = 'openai-completions',
): RuntimeModelPoolNode {
  return {
    modelConfigId: 'synthetic',
    revision: 1,
    weight: 1,
    piApi,
    model: 'synthetic-model',
    apiKey: 'synthetic-probe-key',
    baseUrl,
    providerKey: 'synthetic',
    authMode:
      piApi === 'anthropic-messages'
        ? 'anthropic_api_key'
        : piApi === 'google-generative-ai'
          ? 'gemini_api_key'
          : 'openai_api_key',
  };
}
function send(response: ServerResponse, data: object) {
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}
function answer(response: ServerResponse, api: RuntimeModelPoolNode['piApi']) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  if (api === 'openai-completions') {
    send(response, {
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: 'OK' },
          finish_reason: null,
        },
      ],
    });
    send(response, {
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    });
    response.end('data: [DONE]\n\n');
  } else if (api === 'anthropic-messages') {
    const emit = (type: string, data: object) =>
      response.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
      );
    emit('message_start', {
      message: {
        id: 'msg_synthetic',
        type: 'message',
        role: 'assistant',
        model: 'synthetic-model',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 0 },
      },
    });
    emit('content_block_start', {
      index: 0,
      content_block: { type: 'text', text: '' },
    });
    emit('content_block_delta', {
      index: 0,
      delta: { type: 'text_delta', text: 'OK' },
    });
    emit('content_block_stop', { index: 0 });
    emit('message_delta', {
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 1 },
    });
    emit('message_stop', {});
    response.end();
  } else if (api === 'google-generative-ai') {
    send(response, {
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'OK' }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 3,
        candidatesTokenCount: 1,
        totalTokenCount: 4,
      },
    });
    response.end();
  } else {
    send(response, {
      type: 'response.created',
      response: { id: 'synthetic-response', model: 'synthetic-model' },
    });
    send(response, {
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        type: 'message',
        id: 'synthetic-message',
        role: 'assistant',
        content: [],
        status: 'in_progress',
      },
    });
    send(response, {
      type: 'response.content_part.added',
      item_id: 'synthetic-message',
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '' },
    });
    send(response, {
      type: 'response.output_text.delta',
      item_id: 'synthetic-message',
      output_index: 0,
      content_index: 0,
      delta: 'OK',
    });
    response.end();
  }
}

describe('small availability inference', () => {
  it('does not mark an empty HTTP 200 response with input usage as available', async () => {
    const baseUrl = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      send(response, {
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 0, total_tokens: 3 },
      });
      response.end('data: [DONE]\n\n');
    });
    expect(
      await probeModelAvailability(node(baseUrl), new AbortController().signal),
    ).toBeNull();
  });

  it.each([
    'openai-completions',
    'openai-responses',
    'anthropic-messages',
    'google-generative-ai',
  ] as const)(
    'checks %s with a tiny response limit and no user history or tools',
    async (api) => {
      let body:
        | {
            max_tokens?: number;
            max_completion_tokens?: number;
            max_output_tokens?: number;
            generationConfig?: { maxOutputTokens?: number };
            tools?: unknown;
          }
        | undefined;
      let calls = 0;
      const baseUrl = await serve((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (data: Buffer) => chunks.push(data));
        request.on('end', () => {
          calls += 1;
          body = JSON.parse(Buffer.concat(chunks).toString());
          answer(response, api);
        });
      });
      const result = await probeModelAvailability(
        node(baseUrl, api),
        new AbortController().signal,
        2000,
      );
      expect(result).toBeTypeOf('number');
      expect(result).toBeGreaterThanOrEqual(0);
      expect(calls).toBe(1);
      const cap =
        body!.max_tokens ??
        body!.max_completion_tokens ??
        body!.max_output_tokens ??
        body!.generationConfig?.maxOutputTokens;
      expect(cap).toBe(16);
      expect(body!.tools).toBeUndefined();
      expect(JSON.stringify(body)).toContain('Reply OK.');
    },
  );
  it('bounds silent providers and never retries failed credentials', async () => {
    let calls = 0;
    const silent = await serve((_request, response) => {
      calls += 1;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
    });
    expect(
      await probeModelAvailability(
        node(silent),
        new AbortController().signal,
        30,
      ),
    ).toBeNull();
    expect(calls).toBe(1);
    const denied = await serve((_request, response) => {
      calls += 1;
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end('{"error":{"message":"synthetic unauthorized"}}');
    });
    expect(
      await probeModelAvailability(node(denied), new AbortController().signal),
    ).toBeNull();
    expect(calls).toBe(2);
    expect(
      await probeModelAvailability(node(denied), AbortSignal.abort()),
    ).toBeNull();
    expect(calls).toBe(2);
  });
});
