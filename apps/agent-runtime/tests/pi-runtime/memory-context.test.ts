import { describe, expect, it, vi } from 'vitest';
import type {
  AgentSession,
  Extension,
  SessionBeforeCompactEvent,
} from '@earendil-works/pi-coding-agent';
import type {
  MemoryCaller,
  MemoryResult,
} from '@fateclaw/contracts/agent/memory';
import {
  MAX_MEMORY_HYDRATE_REFERENCES,
  MAX_MEMORY_QUERY_CHARS,
  type MemoryExcerpt,
  type MemoryReference,
  type MemoryRequestScope,
} from '@fateclaw/contracts/memory';

import { createRequestScope } from '#agent/request-scope';
import {
  memoryReferenceKey,
  type RequestMemoryExcerpts,
} from '#agent/memory-client';
import {
  createManagedMemoryCompactionExtension,
  installManagedMemoryProjection,
} from '#agent/pi-runtime/memory-context';
import { MEMORY_RESULT_FORMAT } from '#agent/pi-runtime/tools/memory-tool';

type Messages = Parameters<
  NonNullable<AgentSession['agent']['transformContext']>
>[0];

const scope: MemoryRequestScope = {
  scopeId: 'synthetic-scope',
  ownerUserId: 'synthetic-owner',
  actorKey: 'synthetic-actor',
  audienceKey: 'private',
  subjectId: 'synthetic-subject',
  epoch: 4,
  learningEnabled: true,
  recallEnabled: true,
  chatEditingEnabled: true,
  contextGeneration: 3,
  contextAudience: 'sender-a',
};
const earlier = { kind: 'item' as const, id: 'earlier-item', revision: 2 };
const automatic = { kind: 'item' as const, id: 'core-item', revision: 1 };

function readResult(
  references: MemoryReference[],
  toolName = 'get_memory_source',
) {
  const metadata = {
    format: MEMORY_RESULT_FORMAT,
    status: 'ready',
    references,
  };
  return {
    role: 'toolResult',
    toolName,
    toolCallId: `call-${references.map((item) => item.id).join('-')}`,
    content: [{ type: 'text', text: JSON.stringify(metadata) }],
    details: metadata,
    isError: false,
    timestamp: 3,
  };
}

const history = (): Messages =>
  [
    { role: 'user', content: 'Earlier question', timestamp: 1 },
    readResult([earlier], 'search_memory'),
    { role: 'user', content: 'Current question', timestamp: 4 },
  ] as Messages;

function prepared(excerpts: MemoryExcerpt[], overrides = {}): MemoryResult {
  return {
    ok: true,
    mode: 'prepare',
    hydration: {
      status: 'ready',
      epoch: 4,
      contextGeneration: 3,
      contextAudience: 'sender-a',
      tokenBudget: 2000,
      excerpts,
      ...overrides,
    },
  };
}

function install(
  memory: MemoryCaller | undefined,
  options: {
    currentScope?: MemoryRequestScope;
    query?: string;
    excerpts?: RequestMemoryExcerpts;
  } = {},
) {
  const agent = {} as AgentSession['agent'];
  const excerpts = options.excerpts ?? new Map();
  installManagedMemoryProjection({
    agent,
    memory,
    scope: options.currentScope ?? scope,
    query: options.query ?? 'Current question',
    requestScope: createRequestScope(),
    excerpts,
  });
  return {
    excerpts,
    project: (messages: Messages) => agent.transformContext!(messages),
  };
}

describe('managed memory provider projection', () => {
  it('prepares once per request with earlier references oldest first and reuses the projection on later steps', async () => {
    const memory = vi.fn<MemoryCaller>(async () =>
      prepared([
        { reference: earlier, text: 'EARLIER_BODY', label: 'Earlier' },
        { reference: automatic, text: 'CORE_BODY', label: 'Core' },
      ]),
    );
    const { project } = install(memory);
    const messages = [
      ...history().slice(0, 1),
      readResult([{ kind: 'source', id: 'oldest', revision: 1 }]),
      ...history().slice(1),
    ] as Messages;
    const before = JSON.stringify(messages);
    const first = await project(messages);
    const second = await project(messages);
    expect(memory).toHaveBeenCalledOnce();
    expect(memory).toHaveBeenCalledWith(
      {
        mode: 'prepare',
        query: 'Current question',
        references: [{ kind: 'source', id: 'oldest', revision: 1 }, earlier],
      },
      undefined,
    );
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(JSON.stringify(messages)).toBe(before);
    // The earlier search result shows its own excerpt; core memory goes before the latest user message.
    const tool = first.find(
      (message) =>
        message.role === 'toolResult' && message.toolName === 'search_memory',
    );
    expect(JSON.stringify(tool)).toContain('EARLIER_BODY');
    expect(first.at(-1)).toMatchObject({ content: 'Current question' });
    expect(JSON.stringify(first.at(-2))).toContain('CORE_BODY');
    expect(JSON.stringify(first.at(-2))).not.toContain('EARLIER_BODY');
  });

  it('adds no context message when prepare returns no excerpts or recall is disabled', async () => {
    const empty = vi.fn<MemoryCaller>(async () => prepared([]));
    const output = await install(empty).project(history());
    expect(output).toHaveLength(3);
    const disabled = vi.fn<MemoryCaller>();
    const off = await install(disabled, {
      currentScope: { ...scope, recallEnabled: false },
    }).project(history());
    expect(disabled).not.toHaveBeenCalled();
    expect(off).toHaveLength(3);
    expect(JSON.stringify(off[1])).toContain('disabled');
  });

  it('continues without memory when the RPC throws, fails or answers for another context', async () => {
    for (const memory of [
      vi.fn<MemoryCaller>(async () => {
        throw new Error('SYNTHETIC_PRIVATE_FAILURE');
      }),
      vi.fn<MemoryCaller>(async () => ({
        ok: false,
        code: 'MEMORY.TIMEOUT',
        error: 'timeout',
      })),
      vi.fn<MemoryCaller>(async () =>
        prepared(
          [{ reference: automatic, text: 'WRONG_AUDIENCE', label: 'Core' }],
          { contextAudience: 'sender-b' },
        ),
      ),
      vi.fn<MemoryCaller>(async () =>
        prepared(
          [{ reference: automatic, text: 'WRONG_EPOCH', label: 'Core' }],
          { epoch: 5 },
        ),
      ),
    ]) {
      const { project } = install(memory);
      const output = await project(history());
      expect(output).toHaveLength(3);
      expect(JSON.stringify(output)).not.toMatch(
        /SYNTHETIC_PRIVATE_FAILURE|WRONG_AUDIENCE|WRONG_EPOCH/,
      );
      expect(JSON.stringify(output[1])).toContain('unavailable');
      await project(history());
      expect(memory).toHaveBeenCalledOnce();
    }
  });

  it('projects text a read tool stored during the request into its own result only', async () => {
    const read = { kind: 'source' as const, id: 'source', revision: 1 };
    const { project, excerpts } = install(
      vi.fn<MemoryCaller>(async () => prepared([])),
    );
    excerpts.set(memoryReferenceKey(read), {
      reference: read,
      text: 'TOOL_READ_BODY',
      label: 'Source',
    });
    const messages = [...history(), readResult([read])] as Messages;
    const output = await project(messages);
    expect(JSON.stringify(output.at(-1))).toContain('TOOL_READ_BODY');
    expect(output).toHaveLength(4);
    expect(JSON.stringify(messages)).not.toContain('TOOL_READ_BODY');
    // A reference without text this turn is reported as missing, not as an empty success.
    expect(output[1]).toMatchObject({ details: { status: 'unavailable' } });
  });

  it('keeps long queries and accumulated references within the contract limits', async () => {
    const messages = [
      { role: 'user', content: 'Earlier', timestamp: 1 },
      ...Array.from({ length: MAX_MEMORY_HYDRATE_REFERENCES + 5 }, (_, index) =>
        readResult([{ kind: 'item', id: `item-${index}`, revision: 1 }]),
      ),
      { role: 'user', content: 'Current', timestamp: 2 },
    ] as Messages;
    const memory = vi.fn<MemoryCaller>(async () => prepared([]));
    await install(memory, {
      query: 'x'.repeat(MAX_MEMORY_QUERY_CHARS + 500),
    }).project(messages);
    const operation = memory.mock.calls[0][0];
    if (operation.mode !== 'prepare') throw new Error('Expected prepare');
    expect(operation.query).toHaveLength(MAX_MEMORY_QUERY_CHARS);
    expect(operation.references).toHaveLength(MAX_MEMORY_HYDRATE_REFERENCES);
    expect(operation.references[0].id).toBe('item-5');
  });

  it('never trusts legacy payloads in tool results and strips them before compaction', async () => {
    const legacy = {
      ...readResult([]),
      content: [{ type: 'text', text: 'LEGACY_READ_BODY' }],
      details: { content: 'LEGACY_READ_BODY' },
    };
    const memory = vi.fn<MemoryCaller>(async () => prepared([]));
    const output = await install(memory).project([
      ...history(),
      legacy,
    ] as Messages);
    expect(JSON.stringify(output)).not.toContain('LEGACY_READ_BODY');
    const operation = memory.mock.calls[0][0];
    expect(operation).toMatchObject({ references: [earlier] });

    const extension: Extension = createManagedMemoryCompactionExtension();
    const handler = extension.handlers.get('session_before_compact')![0];
    const canonical = [legacy] as Messages;
    const original = JSON.stringify(canonical);
    const preparation = {
      messagesToSummarize: canonical,
      turnPrefixMessages: canonical,
    } as SessionBeforeCompactEvent['preparation'];
    expect(
      await handler({ preparation } as never, {} as never),
    ).toBeUndefined();
    expect(JSON.stringify(preparation)).not.toContain('LEGACY_READ_BODY');
    expect(JSON.stringify(canonical)).toBe(original);
    // Pi swallows handler errors, so a failure must cancel instead of summarizing raw messages.
    const broken = {
      preparation: {
        messagesToSummarize: null,
        turnPrefixMessages: [],
      },
    };
    expect(await handler(broken as never, {} as never)).toEqual({
      cancel: true,
    });
  });
});
