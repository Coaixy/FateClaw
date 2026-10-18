import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('#agent/ai-chat-stream', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#agent/ai-chat-stream')>()),
  publishAiChatStreamEvent: vi.fn(async () => {}),
}));

import type { AgentRuntimeDeps } from '#agent/deps';
import { runPiSession } from '#agent/pi-runtime/session';
import { createRequestScope } from '#agent/request-scope';
import type { ContainerInput } from '#agent/types';

const servers: ReturnType<typeof createServer>[] = [];
const directories: string[] = [];
const sessionId = 'synthetic-session';
const provider = 'fateclaw-openai-completions-synthetic-provider';
const model = 'synthetic-model';

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

function send(response: ServerResponse, delta: object, toolCall = false) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: toolCall ? 'tool_calls' : 'stop',
        },
      ],
      usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
    })}\n\ndata: [DONE]\n\n`,
  );
  response.end();
}

interface RequestBody {
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ function: { name: string } }>;
}

async function setup(
  handle: (body: RequestBody, response: ServerResponse, index: number) => void,
) {
  const requests: RequestBody[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as RequestBody;
      requests.push(body);
      handle(body, response, requests.length - 1);
    });
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing test address');
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'fateclaw-pi-lifecycle-'),
  );
  directories.push(dir);
  vi.stubEnv('FATECLAW_PI_SESSION_DIR', dir);
  const deps: AgentRuntimeDeps = {
    soulStore: {
      read: vi.fn(async () => 'Synthetic preferences'),
      canEdit: vi.fn(async () => true),
      update: vi.fn(async () => true),
    },
    skillCatalog: { listEffectiveUserSkills: vi.fn(async () => []) },
    skillRevisions: { readRevision: vi.fn(async () => null) },
  };
  const input: ContainerInput = {
    accountId: 'web:synthetic-user',
    sessionId,
    userMessage: 'Synthetic current question',
    llmRuntime: {
      source: 'official',
      billingMode: 'none',
      modelConfigId: 'synthetic',
      piApi: 'openai-completions',
      model,
      providerKey: 'synthetic-provider',
      apiKey: 'synthetic-session-key',
      authMode: 'openai_api_key',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      thinkingLevel: 'off',
    },
  };
  const run = (containerInput = input) => {
    const scope = createRequestScope();
    return runPiSession({
      containerInput,
      runtime: { deps },
      requestScope: scope,
    }).then((result) => ({ result, scope }));
  };
  return { dir, deps, input, requests, run };
}

// Pi 0.86 wrote version-3 entry trees without the newer context-edit or timing fields.
async function seedV3(
  dir: string,
  turns: number,
  text: string,
  inputTokens = 11,
) {
  const entries: object[] = [
    {
      type: 'session',
      version: 3,
      id: sessionId,
      timestamp: '2026-09-20T00:00:00.000Z',
      cwd: process.cwd(),
    },
  ];
  let parentId: string | null = null;
  for (let turn = 0; turn < turns; turn += 1) {
    const userId = `user${turn}`;
    const assistantId = `reply${turn}`;
    const timestamp = Date.UTC(2026, 8, 20, 0, turn);
    entries.push(
      {
        type: 'message',
        id: userId,
        parentId,
        timestamp: new Date(timestamp).toISOString(),
        message: { role: 'user', content: `${text} ${turn}`, timestamp },
      },
      {
        type: 'message',
        id: assistantId,
        parentId: userId,
        timestamp: new Date(timestamp + 1).toISOString(),
        message: {
          role: 'assistant',
          api: 'openai-completions',
          provider,
          model,
          content: [
            { type: 'thinking', thinking: 'SYNTHETIC_THINKING_ONLY' },
            { type: 'text', text: `Synthetic legacy answer ${turn}` },
          ],
          usage: {
            input: inputTokens,
            output: 3,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: inputTokens + 3,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: 'stop',
          timestamp: timestamp + 1,
        },
      },
    );
    parentId = assistantId;
  }
  await fs.writeFile(
    path.join(dir, 'legacy.jsonl'),
    `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
  );
  await fs.writeFile(path.join(dir, `${sessionId}.path`), 'legacy.jsonl');
}

describe('Pi SDK session lifecycle', () => {
  it('resumes version-3 history, executes host tools, and reopens the completed conversation', async () => {
    const { dir, input, requests, run } = await setup(
      (_body, response, index) => {
        if (index === 0) {
          send(
            response,
            {
              tool_calls: [
                {
                  index: 0,
                  id: 'synthetic-read',
                  type: 'function',
                  function: { name: 'read_soul', arguments: '{}' },
                },
              ],
            },
            true,
          );
        } else
          send(response, {
            content:
              index === 1 ? 'Synthetic answer' : 'Synthetic continuation',
          });
      },
    );
    await seedV3(dir, 1, 'Synthetic legacy question');
    const { result } = await run();
    expect(result.text).toBe('Synthetic answer');
    expect(result.usage).toEqual({
      promptTokens: 22,
      completionTokens: 6,
      totalTokens: 28,
    });
    expect(result.records.map((record) => record.invocation.toolName)).toEqual([
      'read_soul',
    ]);
    expect(JSON.stringify(requests[0].messages)).toContain(
      'Synthetic legacy question',
    );
    expect(JSON.stringify(requests[0].messages)).toContain(
      'Synthetic legacy answer',
    );
    expect(requests[0].tools?.map((tool) => tool.function.name).sort()).toEqual(
      [
        'edit_soul',
        'get_current_time',
        'get_ganzhi_by_datetime',
        'read_soul',
        'reverse_ganzhi',
      ],
    );
    expect(
      JSON.stringify(
        requests[1].messages.find((message) => message.role === 'tool'),
      ),
    ).toContain('Synthetic preferences');
    const resumed = await run({ ...input, userMessage: 'Synthetic follow-up' });
    expect(resumed.result.text).toBe('Synthetic continuation');
    expect(JSON.stringify(requests[2].messages)).toContain('Synthetic answer');
    expect(JSON.stringify(requests[2].messages)).toContain(
      'Synthetic follow-up',
    );
    const persisted = (
      await fs.readFile(path.join(dir, 'legacy.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(persisted[0]).toMatchObject({
      type: 'session',
      version: 3,
      id: sessionId,
    });
    expect(
      persisted.filter((entry) => entry.message?.role === 'assistant'),
    ).toHaveLength(4);
  });

  it('rejects malformed write arguments before host execution and lets the model recover', async () => {
    const valid = JSON.stringify({
      baseHash: createHash('sha256')
        .update('Synthetic preferences')
        .digest('hex'),
      newContent: 'Synthetic changed preferences',
      reason: 'Synthetic edit',
    });
    const malformed = `${valid.slice(0, -1)}, "broken": }`;
    const { deps, requests, run } = await setup((_body, response, index) => {
      if (index === 0) {
        send(
          response,
          {
            tool_calls: [
              {
                index: 0,
                id: 'synthetic-edit',
                type: 'function',
                function: { name: 'edit_soul', arguments: malformed },
              },
            ],
          },
          true,
        );
      } else send(response, { content: 'Synthetic recovered answer' });
    });
    const { result, scope } = await run();
    expect(result.text).toBe('Synthetic recovered answer');
    expect(deps.soulStore.update).not.toHaveBeenCalled();
    expect(result.records).toEqual([]);
    const error = requests[1].messages.find(
      (message) => message.role === 'tool',
    );
    expect(JSON.stringify(error)).toContain('Invalid arguments');
    expect(JSON.stringify(error)).toContain('broken');
    expect(scope.traceEvents).toContainEqual(
      expect.objectContaining({ type: 'pi_tool_execution_end', isError: true }),
    );
  });

  it('automatically compacts persisted history without replaying thinking into the summary request', async () => {
    const { dir, input, requests, run } = await setup(
      (_body, response, index) => {
        send(response, {
          content:
            index === 0
              ? 'Synthetic compacted history'
              : 'Synthetic current answer',
        });
      },
    );
    await seedV3(dir, 6, 'Synthetic history '.repeat(1200), 60_000);
    const { result, scope } = await run({
      ...input,
      llmRuntime: {
        ...input.llmRuntime,
        contextWindowTokens: 64_000,
        maxOutputTokens: 128,
      },
    });
    expect(result.text).toBe('Synthetic current answer');
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[0].messages)).not.toContain(
      'SYNTHETIC_THINKING_ONLY',
    );
    expect(JSON.stringify(requests[1].messages)).toContain(
      'Synthetic compacted history',
    );
    expect(JSON.stringify(requests[1].messages)).toContain(input.userMessage);
    expect(scope.traceEvents).toContainEqual(
      expect.objectContaining({
        type: 'pi_compaction_end',
        event: expect.objectContaining({
          aborted: false,
          result: expect.any(Object),
        }),
      }),
    );
    const persisted = await fs.readFile(path.join(dir, 'legacy.jsonl'), 'utf8');
    expect(
      persisted
        .split('\n')
        .some((line) => line && JSON.parse(line).type === 'compaction'),
    ).toBe(true);
  });
});
