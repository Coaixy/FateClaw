import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';

import { createPiProviderRuntime } from '../../src/pi-runtime/provider.js';
import type { LlmRuntimeSnapshot } from '../../src/types.js';

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
  return `http://127.0.0.1:${address.port}/v1`;
}

function runtime(baseUrl: string, apiKey: string): LlmRuntimeSnapshot {
  return {
    // Synthetic host-managed provider; BYOK private-address rejection stays enabled.
    source: 'official',
    billingMode: 'none',
    modelConfigId: 'synthetic',
    piApi: 'openai-completions',
    model: 'synthetic-model',
    apiKey,
    baseUrl,
    authMode: 'openai_api_key',
    providerKey: 'synthetic-provider',
  };
}

function chunk(response: ServerResponse, payload: unknown) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

describe('Pi provider transport', () => {
  it('keeps concurrent request credentials isolated and preserves prompt, tools, text and usage', async () => {
    const requests: Array<{
      authorization?: string;
      body: Record<string, unknown>;
    }> = [];
    const baseUrl = await serve((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (data: Buffer) => chunks.push(data));
      request.on('end', () => {
        requests.push({
          authorization: request.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString()),
        });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        chunk(response, {
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'Synthetic reply' },
              finish_reason: null,
            },
          ],
        });
        chunk(response, {
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
        });
        response.end('data: [DONE]\n\n');
      });
    });
    const replies = await Promise.all(
      ['synthetic-a', 'synthetic-b'].map(async (key) => {
        const provider = await createPiProviderRuntime(runtime(baseUrl, key));
        return provider.modelRuntime.completeSimple(provider.model, {
          systemPrompt: 'Synthetic system instruction',
          messages: [
            { role: 'user', content: 'Synthetic question', timestamp: 1 },
          ],
          tools: [
            {
              name: 'synthetic_tool',
              description: 'Synthetic tool',
              parameters: { type: 'object', properties: {} },
            },
          ],
        });
      }),
    );
    expect(requests).toHaveLength(2);
    expect(new Set(requests.map((request) => request.authorization))).toEqual(
      new Set(['Bearer synthetic-a', 'Bearer synthetic-b']),
    );
    for (const request of requests) {
      expect(request.body.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'system',
            content: 'Synthetic system instruction',
          }),
          expect.objectContaining({
            role: 'user',
            content: 'Synthetic question',
          }),
        ]),
      );
      expect(request.body.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            function: expect.objectContaining({ name: 'synthetic_tool' }),
          }),
        ]),
      );
    }
    for (const reply of replies) {
      expect(reply.stopReason).toBe('stop');
      expect(reply.content).toEqual([
        { type: 'text', text: 'Synthetic reply' },
      ]);
      expect(reply.usage).toMatchObject({
        input: 11,
        output: 3,
        totalTokens: 14,
      });
    }
  });

  it('aborts a provider stream without waiting for the server to finish', async () => {
    const controller = new AbortController();
    const baseUrl = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
      controller.abort();
    });
    const provider = await createPiProviderRuntime(
      runtime(baseUrl, 'synthetic-cancel'),
    );
    const result = await provider.modelRuntime.completeSimple(
      provider.model,
      {
        messages: [
          { role: 'user', content: 'Synthetic pending request', timestamp: 1 },
        ],
      },
      { signal: controller.signal },
    );
    expect(result.stopReason).toBe('aborted');
  });
});
