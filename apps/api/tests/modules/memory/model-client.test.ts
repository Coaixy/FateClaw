import { once } from 'node:events';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MEMORY_RUNTIME_POLICY } from '@fateclaw/contracts/memory';
import {
  resolveMemoryModel,
  runMemoryText,
  type MemoryModelConnection,
} from '#modules/memory/model-client';

const officialRuntime = vi.hoisted(() => vi.fn());
vi.mock('#modules/system/system-config', () => ({
  resolveOfficialLlmRuntime: officialRuntime,
}));

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  officialRuntime.mockReset();
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
});

function connection(
  baseUrl = 'http://127.0.0.1:1/v1',
  piApi: MemoryModelConnection['piApi'] = 'openai-completions',
): MemoryModelConnection {
  return {
    modelConfigId: 'synthetic-node',
    providerKey: 'synthetic',
    piApi,
    model: 'synthetic-chat-model',
    apiKey: 'synthetic-memory-test-key',
    baseUrl,
    authMode:
      piApi === 'google-generative-ai'
        ? 'gemini_api_key'
        : piApi === 'anthropic-messages'
          ? 'anthropic_api_key'
          : 'openai_api_key',
  };
}

const policy = {
  ...DEFAULT_MEMORY_RUNTIME_POLICY,
  job_timeout_ms: 10_000,
};

async function serve(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => Promise<void> | void,
) {
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing test address');
  return `http://127.0.0.1:${address.port}`;
}

async function body(request: IncomingMessage) {
  let text = '';
  for await (const chunk of request) text += chunk.toString();
  return JSON.parse(text) as Record<string, unknown>;
}

describe('memory model execution', () => {
  it('uses the canonical primary or the exact enabled official node without pool billing metadata', async () => {
    const primary = connection();
    const selected = { ...connection(), modelConfigId: 'selected-node' };
    officialRuntime.mockResolvedValue({
      poolNodes: [primary, selected],
      benefitRequestId: 'must-not-reuse',
      contextWindowTokens: 8192,
      maxOutputTokens: 2048,
    });
    const signal = new AbortController().signal;
    expect(await resolveMemoryModel(null, signal)).toMatchObject(primary);
    const node = await resolveMemoryModel('selected-node', signal);
    expect(node.modelConfigId).toBe('selected-node');
    expect(node).not.toHaveProperty('benefitRequestId');
    await expect(
      resolveMemoryModel('disabled-node', signal),
    ).rejects.toMatchObject({
      code: 'MEMORY_MODEL_UNAVAILABLE',
    });
    expect(officialRuntime).toHaveBeenCalledWith('official');
  });

  it('executes the installed provider adapter against a synthetic stream and reports measured usage', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const baseUrl = await serve(async (request, response) => {
      requestBody = await body(request);
      expect(request.url).toBe('/v1/chat/completions');
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(
        `data: ${JSON.stringify({
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: '{"candidates":[]}' },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
        })}\n\n`,
      );
      response.end('data: [DONE]\n\n');
    });
    const result = await runMemoryText({
      policy,
      modelConfigId: null,
      purpose: 'memory.extract',
      systemPrompt: 'Return JSON.',
      input: '{}',
      resolveModel: async () => connection(`${baseUrl}/v1`),
    });
    expect(result).toMatchObject({
      text: '{"candidates":[]}',
      modelConfigId: 'synthetic-node',
      model: 'synthetic-chat-model',
      usage: { inputTokens: 11, outputTokens: 4 },
    });
    expect(requestBody).toMatchObject({
      model: 'synthetic-chat-model',
      stream: true,
    });
  });

  it('fails bounded calls even when an injected runner ignores cancellation, and hides upstream exceptions', async () => {
    const args = {
      policy: { ...policy, job_timeout_ms: 15 },
      modelConfigId: null,
      purpose: 'memory.extract' as const,
      systemPrompt: 'Return JSON.',
      input: '{}',
      resolveModel: async () => connection(),
    };
    await expect(
      runMemoryText({
        ...args,
        runner: () => new Promise(() => {}),
      }),
    ).rejects.toMatchObject({ code: 'MEMORY_MODEL_TIMEOUT' });
    await expect(
      runMemoryText({
        ...args,
        runner: async () => {
          throw new Error('synthetic-private-upstream-body');
        },
      }),
    ).rejects.toMatchObject({
      code: 'MEMORY_MODEL_FAILED',
      message: '记忆模型调用失败，请检查模型节点状态后重试。',
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      runMemoryText({ ...args, signal: controller.signal }),
    ).rejects.toMatchObject({
      code: 'MEMORY_MODEL_CANCELLED',
    });
  });
});
