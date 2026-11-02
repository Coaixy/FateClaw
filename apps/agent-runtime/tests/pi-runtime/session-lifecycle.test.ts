import { createHash, randomUUID } from 'node:crypto';
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
import * as paipanClient from '#agent/paipan-client';
import * as hostToolClient from '#agent/host-tool-client';
import { visualizationReference } from '@fateclaw/contracts/visualization';
import type {
  MemoryCaller,
  MemoryResult,
} from '@fateclaw/contracts/agent/memory';
import type { VisualizationCaller } from '@fateclaw/contracts/agent/visualization';
import type {
  MemoryExcerpt,
  MemoryRequestScope,
} from '@fateclaw/contracts/memory';
import { databaseModelPoolHealth } from '#agent/model-pool-health';
import {
  hashPiMessages,
  piSessionStorageKey,
} from '@fateclaw/contracts/agent/session';

const servers: ReturnType<typeof createServer>[] = [];
const directories: string[] = [];
const sessionId = 'synthetic-session';
const provider = 'fateclaw-openai-completions-synthetic-provider';
const model = 'synthetic-model';

afterEach(async () => {
  vi.restoreAllMocks();
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
    history: [],
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
  mappingId = sessionId,
) {
  const entries: object[] = [
    {
      type: 'session',
      version: 3,
      id: mappingId,
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
  await fs.writeFile(path.join(dir, `${mappingId}.path`), 'legacy.jsonl');
}

function memoryScope(
  options: { generation?: number; recall?: boolean } = {},
): MemoryRequestScope {
  return {
    scopeId: 'synthetic-scope',
    ownerUserId: 'synthetic-owner',
    actorKey: 'synthetic-actor',
    audienceKey: 'private',
    subjectId: 'synthetic-subject',
    epoch: 1,
    learningEnabled: true,
    recallEnabled: options.recall ?? true,
    chatEditingEnabled: true,
    contextGeneration: options.generation ?? 0,
  };
}

function hydrated(
  mode: 'prepare' | 'read' | 'search',
  excerpts: MemoryExcerpt[],
  contextGeneration = 0,
): MemoryResult {
  return {
    ok: true,
    mode,
    hydration: {
      status: 'ready',
      epoch: 1,
      contextGeneration,
      tokenBudget: 2000,
      excerpts,
    },
  };
}

function runManaged(
  input: ContainerInput,
  deps: AgentRuntimeDeps,
  scope: MemoryRequestScope,
) {
  const requestScope = createRequestScope();
  requestScope.requestId = `synthetic-${randomUUID()}`;
  return runPiSession({
    containerInput: {
      ...input,
      executionId: 'synthetic-execution',
      memoryScope: scope,
    },
    runtime: { deps },
    requestScope,
  });
}

describe('Pi SDK session lifecycle', () => {
  it('isolates ordinary history, tools and compaction for two sender audiences and the owner on one business session', async () => {
    const memory = vi.fn<MemoryCaller>();
    vi.spyOn(hostToolClient, 'createHostToolCaller').mockReturnValue(memory);
    const { dir, input, deps, requests } = await setup(
      (_body, response, index) => {
        if (index === 2)
          send(
            response,
            {
              tool_calls: [
                {
                  index: 0,
                  id: 'sender-a-board-read',
                  type: 'function',
                  function: {
                    name: 'get_session_board',
                    arguments: JSON.stringify({
                      mode: 'detail',
                      sourceMessageId: 'sender-a-board',
                    }),
                  },
                },
              ],
            },
            true,
          );
        else
          send(response, {
            content: [
              'OWNER_COMPACTION_MARKER',
              'OWNER_ASSISTANT_MARKER',
              '',
              'SENDER_A_ASSISTANT_MARKER',
              'SENDER_B_ASSISTANT_MARKER',
              'SENDER_A_SECOND_REPLY',
              'SENDER_B_SECOND_REPLY',
              'OWNER_SECOND_REPLY',
            ][index],
          });
      },
    );
    await seedV3(dir, 6, 'OWNER_HISTORY_MARKER '.repeat(1200), 60_000);
    const ownerMapping = await fs.readFile(
      path.join(dir, `${sessionId}.path`),
      'utf8',
    );
    const runAudience = async (
      audience: string,
      userMessage: string,
      extra: Partial<ContainerInput> = {},
    ) => {
      const requestScope = createRequestScope();
      requestScope.requestId = `synthetic-audience-${requests.length}`;
      return runPiSession({
        containerInput: {
          ...input,
          executionId: 'synthetic-execution',
          userMessage,
          sessionBoardContexts: [],
          authorizedSkillIds: [],
          piSessionBase: null,
          llmRuntime: {
            ...input.llmRuntime,
            contextWindowTokens: 64_000,
            maxOutputTokens: 128,
          },
          memoryScope: {
            scopeId: audience || 'owner',
            ownerUserId: 'synthetic-owner',
            actorKey: audience ? `wechat:${audience}` : 'user:synthetic-owner',
            audienceKey: audience || 'owner',
            subjectId: 'synthetic-subject',
            epoch: 1,
            learningEnabled: false,
            recallEnabled: false,
            chatEditingEnabled: false,
            contextGeneration: 0,
            contextAudience: audience,
            memorySpaceId: 'synthetic-shared-owner-memory',
          },
          ...extra,
        },
        runtime: { deps },
        requestScope,
      });
    };
    const owner = await runAudience('', 'OWNER_CURRENT_USER_MARKER');
    const a = await runAudience('sender-a', 'SENDER_A_USER_MARKER', {
      sessionBoardContexts: [
        {
          sourceMessageId: 'sender-a-board',
          source: 'official_paipan',
          skill: 'bazi-paipan',
          promptText: 'SENDER_A_TOOL_MARKER',
          isCurrent: true,
        },
      ],
    });
    const emptyA = {
      requestId: 'synthetic-empty-a',
      messagesHash: hashPiMessages([]),
      messageCount: 0,
      checkpointDepth: 0,
      contextGeneration: 0,
      contextAudience: 'sender-a',
    };
    const b = await runAudience('sender-b', 'SENDER_B_USER_MARKER', {
      piSessionBase: emptyA,
    });
    if (!a.piSession || !('messagesHash' in a.piSession))
      throw new Error('Missing sender A frame');
    await runAudience('sender-a', 'SENDER_A_FOLLOW_UP', {
      piSessionBase: {
        requestId: 'sender-a-first',
        messagesHash: a.piSession.messagesHash,
        messageCount: a.piSession.messageCount,
        checkpointDepth: a.piSession.checkpointDepth,
        contextGeneration: 0,
        contextAudience: 'sender-a',
      },
    });
    await runAudience('sender-b', 'SENDER_B_FOLLOW_UP');
    await runAudience('', 'OWNER_FOLLOW_UP');
    expect(requests).toHaveLength(8);
    for (const index of [2, 3, 5]) {
      expect(JSON.stringify(requests[index])).not.toContain(
        'OWNER_HISTORY_MARKER',
      );
      expect(JSON.stringify(requests[index])).not.toContain(
        'OWNER_COMPACTION_MARKER',
      );
      expect(JSON.stringify(requests[index])).not.toContain(
        'OWNER_ASSISTANT_MARKER',
      );
      expect(JSON.stringify(requests[index])).not.toContain('SENDER_B_');
    }
    for (const index of [4, 6]) {
      expect(JSON.stringify(requests[index])).not.toContain(
        'OWNER_HISTORY_MARKER',
      );
      expect(JSON.stringify(requests[index])).not.toContain(
        'OWNER_COMPACTION_MARKER',
      );
      expect(JSON.stringify(requests[index])).not.toContain('SENDER_A_');
    }
    expect(JSON.stringify(requests[5])).toContain('SENDER_A_USER_MARKER');
    expect(JSON.stringify(requests[5])).toContain('SENDER_A_ASSISTANT_MARKER');
    expect(JSON.stringify(requests[5])).toContain('SENDER_A_TOOL_MARKER');
    expect(JSON.stringify(requests[6])).toContain('SENDER_B_USER_MARKER');
    expect(JSON.stringify(requests[6])).toContain('SENDER_B_ASSISTANT_MARKER');
    expect(JSON.stringify(requests[7])).toContain('OWNER_COMPACTION_MARKER');
    expect(JSON.stringify(requests[7])).toContain('OWNER_ASSISTANT_MARKER');
    expect(JSON.stringify(requests[7])).not.toContain('SENDER_A_');
    expect(JSON.stringify(requests[7])).not.toContain('SENDER_B_');
    expect(owner.piSession).toMatchObject({
      contextAudience: '',
      contextGeneration: 0,
    });
    expect(b.piSession).toMatchObject({
      kind: 'checkpoint',
      contextAudience: 'sender-b',
    });
    expect(await fs.readFile(path.join(dir, `${sessionId}.path`), 'utf8')).toBe(
      ownerMapping,
    );
    for (const audience of ['sender-a', 'sender-b'])
      expect(
        await fs.readFile(
          path.join(dir, `${piSessionStorageKey(sessionId, 0, audience)}.path`),
          'utf8',
        ),
      ).toBeTruthy();
  });

  it('prepares memory once per request, projects searched text only to the provider and persists references only', async () => {
    const core = { kind: 'item' as const, id: 'synthetic-core', revision: 1 };
    const searched = {
      kind: 'item' as const,
      id: 'synthetic-searched',
      revision: 1,
    };
    const memory = vi.fn<MemoryCaller>(async (operation) => {
      if (operation.mode === 'prepare')
        return hydrated(
          'prepare',
          [{ reference: core, text: 'EPHEMERAL_CORE_FACT', label: 'Core' }],
          3,
        );
      if (operation.mode === 'search')
        return hydrated(
          'search',
          [
            {
              reference: searched,
              text: 'EPHEMERAL_SEARCHED_FACT',
              label: 'Searched',
            },
          ],
          3,
        );
      throw new Error('Unexpected synthetic memory operation');
    });
    vi.spyOn(hostToolClient, 'createHostToolCaller').mockReturnValue(memory);
    const { dir, input, deps, requests } = await setup(
      (_body, response, index) => {
        if (index === 0)
          send(
            response,
            {
              tool_calls: [
                {
                  index: 0,
                  id: 'synthetic-search',
                  type: 'function',
                  function: {
                    name: 'search_memory',
                    arguments: JSON.stringify({ query: 'Synthetic' }),
                  },
                },
              ],
            },
            true,
          );
        else send(response, { content: 'Synthetic managed answer' });
      },
    );
    const result = await runManaged(
      input,
      deps,
      memoryScope({ generation: 3 }),
    );
    expect(result.text).toBe('Synthetic managed answer');
    expect(requests).toHaveLength(2);
    expect(
      memory.mock.calls.filter(([operation]) => operation.mode === 'prepare'),
    ).toHaveLength(1);
    expect(memory).toHaveBeenCalledWith(
      {
        mode: 'prepare',
        query: 'Synthetic current question',
        references: [],
      },
      expect.any(AbortSignal),
    );
    for (const request of requests) {
      const messages = request.messages;
      const latestUser =
        messages.length -
        1 -
        [...messages].reverse().findIndex((message) => message.role === 'user');
      expect(JSON.stringify(messages[latestUser - 1])).toContain(
        'EPHEMERAL_CORE_FACT',
      );
      expect(JSON.stringify(messages[latestUser])).toContain(
        'Synthetic current question',
      );
    }
    expect(
      JSON.stringify(
        requests[1].messages.find((message) => message.role === 'tool'),
      ),
    ).toContain('EPHEMERAL_SEARCHED_FACT');
    expect(JSON.stringify(result)).not.toContain('EPHEMERAL_');
    const mapping = await fs.readFile(
      path.join(dir, `${piSessionStorageKey(sessionId, 3, '')}.path`),
      'utf8',
    );
    const persisted = await fs.readFile(path.join(dir, mapping), 'utf8');
    expect(persisted).not.toContain('EPHEMERAL_');
    expect(persisted).toContain('fateclaw-memory-reference-v1');
    expect(persisted).toContain('synthetic-searched');
  });

  it('reuses the prepared projection across a provider retry and a pool failover of the same request', async () => {
    const core = { kind: 'item' as const, id: 'synthetic-core', revision: 1 };
    const memory = vi.fn<MemoryCaller>(async () =>
      hydrated('prepare', [
        { reference: core, text: 'EPHEMERAL_RETRY_FACT', label: 'Core' },
      ]),
    );
    vi.spyOn(hostToolClient, 'createHostToolCaller').mockReturnValue(memory);
    vi.spyOn(databaseModelPoolHealth, 'claim').mockResolvedValue({
      generation: 0,
      token: null,
    });
    vi.spyOn(databaseModelPoolHealth, 'finish').mockResolvedValue();
    const { input, deps, requests } = await setup((_body, response, index) => {
      if (index % 2 === 0) {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end('{"error":{"message":"synthetic unavailable"}}');
      } else send(response, { content: 'Synthetic recovered answer' });
    });
    const retried = await runManaged(input, deps, memoryScope());
    expect(retried.text).toBe('Synthetic recovered answer');
    const node = {
      ...input.llmRuntime,
      piApi: 'openai-completions' as const,
      model: input.llmRuntime.model,
      providerKey: 'synthetic-provider',
      authMode: 'openai_api_key' as const,
      apiKey: 'synthetic-session-key',
      baseUrl: input.llmRuntime.baseUrl!,
      revision: 1,
      weight: 1,
    };
    const failedOver = await runManaged(
      {
        ...input,
        llmRuntime: {
          ...input.llmRuntime,
          billingMode: 'metered',
          poolNodes: [
            { ...node, modelConfigId: 'synthetic-a' },
            { ...node, modelConfigId: 'synthetic-b' },
          ],
        },
      },
      deps,
      memoryScope(),
    );
    expect(failedOver.text).toBe('Synthetic recovered answer');
    expect(requests).toHaveLength(4);
    for (const request of requests)
      expect(JSON.stringify(request)).toContain('EPHEMERAL_RETRY_FACT');
    // One prepare per request: the retry and the failover reused the cached projection.
    expect(memory).toHaveBeenCalledTimes(2);
  }, 15_000);

  it('completes the turn without memory when the memory RPC fails', async () => {
    const memory = vi.fn<MemoryCaller>(async () => ({
      ok: false,
      code: 'MEMORY.TIMEOUT',
      error: 'Synthetic memory outage',
    }));
    vi.spyOn(hostToolClient, 'createHostToolCaller').mockReturnValue(memory);
    const { input, deps, requests } = await setup((_body, response) =>
      send(response, { content: 'Synthetic answer without memory' }),
    );
    const result = await runManaged(input, deps, memoryScope());
    expect(result.text).toBe('Synthetic answer without memory');
    expect(memory).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(1);
    expect(
      requests[0].messages.filter((message) => message.role === 'user'),
    ).toHaveLength(1);
  });

  it('does not replay a forgotten item to later model steps of the same request', async () => {
    const forgotten = {
      kind: 'item' as const,
      id: 'synthetic-forgotten-item',
      revision: 1,
    };
    const remaining = {
      kind: 'item' as const,
      id: 'synthetic-remaining-item',
      revision: 1,
    };
    let isForgotten = false;
    const memory = vi.fn<MemoryCaller>(async (operation) => {
      if (operation.mode === 'forget') {
        isForgotten = true;
        return { ok: true, mode: 'forget', forgottenId: operation.id };
      }
      if (operation.mode === 'prepare')
        return hydrated('prepare', [
          ...(!isForgotten
            ? [
                {
                  reference: forgotten,
                  text: 'SYNTHETIC_FORGOTTEN_MEMORY_BODY',
                  label: 'Old fact',
                },
              ]
            : []),
          {
            reference: remaining,
            text: 'SYNTHETIC_REMAINING_MEMORY_BODY',
            label: 'Remaining fact',
          },
        ]);
      throw new Error('Unexpected synthetic operation');
    });
    vi.spyOn(hostToolClient, 'createHostToolCaller').mockReturnValue(memory);
    const { input, deps, requests } = await setup((_body, response, index) => {
      if (index === 0)
        send(
          response,
          {
            tool_calls: [
              {
                index: 0,
                id: 'synthetic-forget-call',
                type: 'function',
                function: {
                  name: 'forget_memory',
                  arguments: JSON.stringify({ id: forgotten.id, revision: 1 }),
                },
              },
            ],
          },
          true,
        );
      else send(response, { content: '已遗忘。' });
    });
    const result = await runManaged(
      { ...input, userMessage: '请忘记上一条记忆' },
      deps,
      memoryScope(),
    );
    expect(result.text).toBe('已遗忘。');
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[0])).toContain(
      'SYNTHETIC_FORGOTTEN_MEMORY_BODY',
    );
    expect(JSON.stringify(requests[1])).not.toContain(
      'SYNTHETIC_FORGOTTEN_MEMORY_BODY',
    );
    expect(JSON.stringify(requests[1])).toContain(
      'SYNTHETIC_REMAINING_MEMORY_BODY',
    );
    expect(JSON.stringify(result.piSession)).not.toContain('SYNTHETIC_');
    expect(
      memory.mock.calls.filter(([operation]) => operation.mode === 'prepare'),
    ).toHaveLength(2);
  });

  it('injects the Soul persona for every audience and offers Soul tools only to the owner', async () => {
    const memory = vi.fn<MemoryCaller>();
    vi.spyOn(hostToolClient, 'createHostToolCaller').mockReturnValue(memory);
    const { input, deps, requests } = await setup((_body, response) =>
      send(response, { content: 'Synthetic persona answer' }),
    );
    const tools = (index: number) =>
      requests[index].tools?.map((tool) => tool.function.name) ?? [];
    const persona = { ...input, personaPrompt: 'SYNTHETIC_SOUL_PERSONA' };
    await runManaged(persona, deps, {
      ...memoryScope({ recall: false }),
      contextAudience: 'sender-a',
    });
    expect(JSON.stringify(requests[0].messages[0])).toContain(
      'SYNTHETIC_SOUL_PERSONA',
    );
    expect(tools(0)).not.toContain('read_soul');
    expect(tools(0)).not.toContain('edit_soul');
    expect(deps.soulStore.canEdit).not.toHaveBeenCalled();
    expect(deps.soulStore.read).not.toHaveBeenCalled();
    await runManaged(persona, deps, {
      ...memoryScope({ recall: false }),
      ownerAudience: true,
    });
    expect(JSON.stringify(requests[1].messages[0])).toContain(
      'SYNTHETIC_SOUL_PERSONA',
    );
    expect(tools(1)).toEqual(
      expect.arrayContaining(['read_soul', 'edit_soul']),
    );
    expect(tools(1)).not.toContain('search_memory');
    expect(memory).not.toHaveBeenCalled();
  });

  it('carries the admitted execution into Soul tool reads and writes through the real SDK loop', async () => {
    const memory = vi.fn<MemoryCaller>();
    vi.spyOn(hostToolClient, 'createHostToolCaller').mockReturnValue(memory);
    const original = 'Synthetic preferences';
    const baseHash = createHash('sha256').update(original).digest('hex');
    const { input, deps, requests } = await setup((_body, response, index) => {
      if (index > 1) return send(response, { content: 'Synthetic Soul saved' });
      send(
        response,
        {
          tool_calls: [
            {
              index: 0,
              id: `soul-${index}`,
              type: 'function',
              function: {
                name: index === 0 ? 'read_soul' : 'edit_soul',
                arguments:
                  index === 0
                    ? '{}'
                    : JSON.stringify({
                        baseHash,
                        newContent: 'Synthetic updated preferences',
                        reason: 'Explicit request',
                      }),
              },
            },
          ],
        },
        true,
      );
    });
    await runManaged(input, deps, {
      ...memoryScope({ recall: false }),
      ownerAudience: true,
    });
    expect(requests).toHaveLength(3);
    expect(deps.soulStore.update).toHaveBeenCalledWith(
      'web:synthetic-user',
      'Synthetic updated preferences',
      baseHash,
      {
        requestId: expect.stringMatching(/^synthetic-/),
        executionId: 'synthetic-execution',
      },
    );
    expect(deps.soulStore.read).toHaveBeenCalledWith('web:synthetic-user', {
      requestId: expect.stringMatching(/^synthetic-/),
      executionId: 'synthetic-execution',
    });
  });

  it('delivers active tool guidance to the provider and embeds a persisted figure through the tool loop', async () => {
    const id = `visualization-${'a'.repeat(64)}`;
    const figure = {
      type: 'svg' as const,
      title: '五行相生',
      summary: '五行相生关系示意，不代表个人强弱。',
      spec: '<svg viewBox="0 0 480 180"><circle cx="100" cy="90" r="42" fill="var(--color-surface-soft)"/><text x="100" y="98">木</text><path d="M150 90H320" stroke="var(--color-primary)"/><text x="365" y="98">火</text></svg>',
    };
    const caller = vi.fn<VisualizationCaller>(async () => ({
      ok: true,
      sessionId,
      artifact: { ...figure, id, version: 1 },
      createdAt: '2026-10-23T00:00:00Z',
    }));
    // vi.spyOn types only the last overload (memory); this test stubs the visualization caller.
    vi.spyOn(hostToolClient, 'createHostToolCaller').mockReturnValue(
      caller as unknown as MemoryCaller,
    );
    const answer = `先看相生的方向。\n\n${visualizationReference(id)}\n\n箭头表示相生关系。`;
    const { input, deps, requests, run } = await setup(
      (_body, response, index) => {
        if (index === 0)
          send(
            response,
            {
              tool_calls: [
                {
                  index: 0,
                  id: 'synthetic-figure',
                  type: 'function',
                  function: {
                    name: 'render_visualization',
                    arguments: JSON.stringify(figure),
                  },
                },
              ],
            },
            true,
          );
        else send(response, { content: index === 1 ? answer : '文字答复' });
      },
    );
    const scope = createRequestScope();
    scope.requestId = 'synthetic-figure-request';
    const result = await runPiSession({
      containerInput: { ...input, executionId: 'synthetic-execution' },
      runtime: { deps },
      requestScope: scope,
    });
    expect(result.text).toBe(answer);
    expect(caller).toHaveBeenCalledWith(
      { ...figure, toolCallId: 'synthetic-figure' },
      expect.any(AbortSignal),
    );
    const prompt = JSON.stringify(
      requests[0].messages.filter((message) => message.role === 'system'),
    );
    expect(prompt).toContain('语法错误可简化后重新调用');
    expect(prompt).toContain('summary 说明数据来源或示意性质');
    expect(JSON.stringify(requests[1].messages)).toContain(id);

    await run({ ...input, accountId: 'wechat:synthetic-user' });
    expect(requests[2].tools?.map((tool) => tool.function.name)).not.toContain(
      'render_visualization',
    );
    expect(
      JSON.stringify(
        requests[2].messages.filter((message) => message.role === 'system'),
      ),
    ).not.toContain('render_visualization');
  });

  it('creates a chart through the model tool loop and reuses it in a later conversation turn', async () => {
    const board = {
      sourceMessageId: 'saved-chart',
      source: 'official_paipan' as const,
      skill: 'bazi-paipan',
      artifactTitle: '八字排盘',
      promptText: '合成测试盘面：庚午 辛巳 庚辰 辛巳',
      isCurrent: true,
    };
    const caller = vi.fn(async () => ({
      ok: true as const,
      mode: 'create' as const,
      sessionId,
      board,
    }));
    vi.spyOn(paipanClient, 'createPaipanCaller').mockReturnValue(caller);
    const { input, deps, requests } = await setup((_body, response, index) => {
      if (index === 0 || index === 1 || index === 3) {
        send(
          response,
          {
            tool_calls: [
              {
                index: 0,
                id: `synthetic-tool-${index}`,
                type: 'function',
                function:
                  index === 0
                    ? {
                        name: 'create_paipan',
                        arguments: JSON.stringify({
                          mode: 'create',
                          skill: 'bazi-paipan',
                          input: {
                            solarDate: '1990-05-15',
                            hour: 10,
                            gender: '男',
                          },
                        }),
                      }
                    : {
                        name: 'get_session_board',
                        arguments: JSON.stringify({
                          mode: 'detail',
                          sourceMessageId: 'saved-chart',
                        }),
                      },
              },
            ],
          },
          true,
        );
      } else
        send(response, {
          content:
            index === 2
              ? 'Synthetic chart interpretation'
              : 'Synthetic chart follow-up',
        });
    });
    const scope = createRequestScope();
    scope.requestId = 'synthetic-create-request';
    const result = await runPiSession({
      containerInput: { ...input, executionId: 'synthetic-execution' },
      runtime: { deps },
      requestScope: scope,
    });
    expect(result.text).toBe('Synthetic chart interpretation');
    expect(result.records.map((record) => record.invocation.toolName)).toEqual([
      'create_paipan',
      'get_session_board',
    ]);
    expect(requests[0].tools?.map((tool) => tool.function.name)).toContain(
      'create_paipan',
    );
    expect(JSON.stringify(requests[0].messages)).toContain(
      'conversation_paipan_policy',
    );
    expect(JSON.stringify(requests[0].messages)).not.toContain(
      '只能引导用户使用 FateClaw Web/API',
    );
    expect(JSON.stringify(requests[0].messages)).not.toContain(
      '不要自行调用或声称拥有排盘工具',
    );
    expect(JSON.stringify(requests[2].messages)).toContain(board.promptText);

    const next = createRequestScope();
    next.requestId = 'synthetic-follow-up-request';
    const followUp = await runPiSession({
      containerInput: {
        ...input,
        executionId: 'synthetic-next-execution',
        userMessage: '继续看大运',
        sessionBoardContexts: [board],
      },
      runtime: { deps },
      requestScope: next,
    });
    expect(followUp.text).toBe('Synthetic chart follow-up');
    expect(
      followUp.records.map((record) => record.invocation.toolName),
    ).toEqual(['get_session_board']);
    expect(caller).toHaveBeenCalledTimes(1);
  });

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

  it('keeps temporary memory out of automatic compaction requests and the stored summary', async () => {
    const scope = {
      ...memoryScope({ generation: 3 }),
      chatEditingEnabled: false,
    };
    const reference = {
      kind: 'item' as const,
      id: 'synthetic-fact',
      revision: 1,
    };
    const memory = vi.fn<MemoryCaller>(async () =>
      hydrated(
        'prepare',
        [
          {
            reference,
            text: 'EPHEMERAL_MEMORY_EXCLUDED_FROM_COMPACTION',
            label: 'Synthetic evidence',
          },
        ],
        3,
      ),
    );
    vi.spyOn(hostToolClient, 'createHostToolCaller').mockReturnValue(memory);
    const { dir, input, deps, requests } = await setup(
      (_body, response, index) => {
        send(response, {
          content:
            index === 0
              ? 'Synthetic managed compacted history'
              : 'Synthetic managed current answer',
        });
      },
    );
    await seedV3(
      dir,
      6,
      'Synthetic history '.repeat(1200),
      60_000,
      `${sessionId}.memory-3`,
    );
    const requestScope = createRequestScope();
    requestScope.requestId = 'synthetic-managed-compaction';
    const result = await runPiSession({
      containerInput: {
        ...input,
        memoryScope: scope,
        executionId: 'synthetic-execution',
        llmRuntime: {
          ...input.llmRuntime,
          contextWindowTokens: 64_000,
          maxOutputTokens: 128,
        },
      },
      runtime: { deps },
      requestScope,
    });
    expect(result.text).toBe('Synthetic managed current answer');
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[0])).not.toContain(
      'EPHEMERAL_MEMORY_EXCLUDED_FROM_COMPACTION',
    );
    expect(JSON.stringify(requests[1])).toContain(
      'EPHEMERAL_MEMORY_EXCLUDED_FROM_COMPACTION',
    );
    expect(JSON.stringify(result.piSession)).not.toContain(
      'EPHEMERAL_MEMORY_EXCLUDED_FROM_COMPACTION',
    );
    expect(
      await fs.readFile(path.join(dir, 'legacy.jsonl'), 'utf8'),
    ).not.toContain('EPHEMERAL_MEMORY_EXCLUDED_FROM_COMPACTION');
    expect(requestScope.traceEvents).toContainEqual(
      expect.objectContaining({ type: 'pi_compaction_end' }),
    );
  });
});
