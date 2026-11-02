import { describe, expect, it, vi } from 'vitest';
import type {
  MemoryCaller,
  MemoryResult,
} from '@fateclaw/contracts/agent/memory';
import type {
  MemoryExcerpt,
  MemoryRequestScope,
} from '@fateclaw/contracts/memory';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';

import { createRequestScope } from '#agent/request-scope';
import {
  memoryReferenceKey,
  type RequestMemoryExcerpts,
} from '#agent/memory-client';
import { createPiManagedMemoryTools } from '#agent/pi-runtime/tools/memory-tool';
import { createPiEventCollector } from '#agent/pi-runtime/events';

const scope: MemoryRequestScope = {
  scopeId: 'synthetic-scope',
  ownerUserId: 'synthetic-owner',
  actorKey: 'synthetic-actor',
  audienceKey: 'private',
  subjectId: 'synthetic-subject',
  epoch: 1,
  learningEnabled: false,
  recallEnabled: true,
  chatEditingEnabled: true,
  contextGeneration: 1,
};
const item = { kind: 'item' as const, id: 'synthetic-item', revision: 1 };

function hydrated(
  mode: 'read' | 'search',
  excerpts: MemoryExcerpt[],
): MemoryResult {
  return {
    ok: true,
    mode,
    hydration: {
      status: 'ready',
      epoch: 1,
      contextGeneration: 1,
      tokenBudget: 2000,
      excerpts,
    },
  };
}

function tools(
  memory: MemoryCaller | undefined,
  memoryScope = scope,
  excerpts: RequestMemoryExcerpts = new Map(),
) {
  const requestScope = createRequestScope();
  const recordExecution = vi.fn();
  const list = createPiManagedMemoryTools({
    requestScope,
    recordExecution,
    memory,
    memoryScope,
    excerpts,
  });
  const run = (name: string, params: Record<string, unknown>) =>
    list
      .find((tool) => tool.name === name)!
      .execute(`call-${name}`, params, undefined, undefined, {} as never);
  return { list, run, excerpts, requestScope, recordExecution };
}

describe('managed memory tools', () => {
  it('keeps searched text in request memory and returns only references', async () => {
    const memory = vi.fn<MemoryCaller>(async () => ({
      ok: true,
      mode: 'search',
      hydration: {
        status: 'ready',
        epoch: 1,
        contextGeneration: 1,
        tokenBudget: 2000,
        excerpts: [{ reference: item, text: 'SEARCH_BODY', label: 'Fact' }],
      },
    }));
    const { run, excerpts } = tools(memory);
    const result = await run('search_memory', { query: 'Synthetic' });
    expect(memory).toHaveBeenCalledWith(
      { mode: 'search', query: 'Synthetic' },
      undefined,
    );
    expect(result.details).toMatchObject({
      status: 'ready',
      references: [item],
      isError: false,
    });
    expect(JSON.stringify(result)).not.toContain('SEARCH_BODY');
    expect(excerpts.get(memoryReferenceKey(item))?.text).toBe('SEARCH_BODY');
  });

  it('rejects invalid references and dates before calling the host', async () => {
    const memory = vi.fn<MemoryCaller>();
    const { run } = tools(memory);
    for (const [name, params] of [
      ['get_memory_source', { reference: { ...item, revision: 0 } }],
      ['get_memory_source', { reference: { ...item, kind: 'soul' } }],
      ['search_memory', { query: 'Synthetic', after: '2024-02-30T00:00:00Z' }],
      ['search_memory', { query: 'Synthetic', before: 'yesterday' }],
    ] as const) {
      const result = await run(name, params);
      expect(result.details).toMatchObject({
        isError: true,
        code: 'MEMORY.INVALID',
      });
    }
    expect(memory).not.toHaveBeenCalled();
  });

  it('reports a read the host did not hydrate as partial and drops mismatched hydrations', async () => {
    let audience = '';
    const memory = vi.fn<MemoryCaller>(async () => ({
      ok: true,
      mode: 'read',
      hydration: {
        status: 'ready',
        epoch: 1,
        contextGeneration: 1,
        contextAudience: audience,
        tokenBudget: 2000,
        excerpts: audience
          ? [{ reference: item, text: 'OTHER_AUDIENCE', label: 'Fact' }]
          : [],
      },
    }));
    const { run, excerpts } = tools(memory);
    const missing = await run('get_memory_source', { reference: item });
    expect(missing.details).toMatchObject({
      status: 'partial',
      references: [item],
    });
    audience = 'sender-b';
    const mismatched = await run('get_memory_source', { reference: item });
    expect(mismatched.details).toMatchObject({ status: 'unavailable' });
    expect(excerpts.size).toBe(0);
  });

  it('invalidates all cached aliases and sources after a confirmed forget', async () => {
    const memory = vi.fn<MemoryCaller>(async () => ({
      ok: true,
      mode: 'forget',
      forgottenId: item.id,
    }));
    const { run, excerpts } = tools(memory);
    excerpts.set(memoryReferenceKey(item), {
      reference: item,
      text: 'FORGOTTEN_BODY',
      label: 'Fact',
    });
    for (const reference of [
      { ...item, id: 'merged-alias' },
      { kind: 'source' as const, id: 'supporting-source', revision: 1 },
    ])
      excerpts.set(memoryReferenceKey(reference), {
        reference,
        text: 'FORGOTTEN_BODY',
        label: 'Cached evidence',
      });
    const result = await run('forget_memory', { id: item.id, revision: 1 });
    expect(result.details).toMatchObject({ forgottenId: item.id });
    expect(excerpts.size).toBe(0);
  });

  it('does not cache an earlier read that completes after a successful mutation', async () => {
    let finishRead!: (result: MemoryResult) => void;
    const pendingRead = new Promise<MemoryResult>((resolve) => {
      finishRead = resolve;
    });
    const memory = vi.fn<MemoryCaller>(async (operation) =>
      operation.mode === 'read'
        ? pendingRead
        : { ok: true, mode: 'forget', forgottenId: item.id },
    );
    const { run, excerpts } = tools(memory);
    const reading = run('get_memory_source', { reference: item });
    await run('forget_memory', { id: item.id });
    finishRead(
      hydrated('read', [
        { reference: item, text: 'STALE_IN_FLIGHT_BODY', label: 'Fact' },
      ]),
    );
    const result = await reading;
    expect(result.details).toMatchObject({ status: 'unavailable' });
    expect(excerpts.size).toBe(0);
  });

  it('keeps a committed update successful when reading its new value fails, without keeping old text', async () => {
    const updated = { ...item, id: 'updated-item', revision: 2 };
    const memory = vi.fn<MemoryCaller>(async (operation) =>
      operation.mode === 'update'
        ? { ok: true, mode: 'update', reference: updated }
        : { ok: false, code: 'MEMORY.TIMEOUT', error: 'timeout' },
    );
    const { run, excerpts } = tools(memory);
    excerpts.set(memoryReferenceKey(item), {
      reference: item,
      text: 'OLD_BODY',
      label: 'Fact',
    });
    const result = await run('update_memory', {
      id: item.id,
      revision: 1,
      content: 'NEW_BODY',
    });
    expect(result.details).toMatchObject({
      status: 'ready',
      references: [updated],
      isError: false,
    });
    expect(memory).toHaveBeenLastCalledWith(
      { mode: 'read', references: [updated] },
      undefined,
    );
    expect(excerpts.size).toBe(0);
    expect(JSON.stringify(result)).not.toMatch(/OLD_BODY|NEW_BODY/);
  });

  it('does not hydrate a successful update while recall is disabled', async () => {
    const updated = { ...item, revision: 2 };
    const memory = vi.fn<MemoryCaller>(async () => ({
      ok: true,
      mode: 'update',
      reference: updated,
    }));
    const { run, excerpts } = tools(memory, { ...scope, recallEnabled: false });
    const result = await run('update_memory', {
      id: item.id,
      revision: 1,
      content: 'NEW_BODY',
    });
    expect(result.details).toMatchObject({ references: [updated] });
    expect(memory).toHaveBeenCalledOnce();
    expect(excerpts.size).toBe(0);
  });

  it('keeps explicit write arguments for replay while returning only references and tracing only metadata', async () => {
    const memory = vi.fn<MemoryCaller>(
      async () =>
        ({
          ok: true,
          mode: 'remember',
          reference: item,
          text: 'HOST_READ_TEXT_MUST_NOT_RETURN',
        }) as Awaited<ReturnType<MemoryCaller>>,
    );
    const { list, requestScope, recordExecution } = tools(memory);
    const tool = list.find((entry) => entry.name === 'remember_memory')!;
    const params = {
      content: 'SYNTHETIC_WRITE_MUST_NOT_BE_TRACED',
      kind: 'preference',
    };
    const publishStreamEvent = vi.fn();
    const collector = createPiEventCollector({
      requestScope,
      accountId: 'web:synthetic',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      setLastAssistantText() {},
      publishStreamEvent,
    });
    collector({
      type: 'tool_execution_start',
      toolName: tool.name,
      toolCallId: 'synthetic-write',
      args: params,
    } as AgentSessionEvent);
    const result = await tool.execute(
      'synthetic-write',
      params,
      undefined,
      undefined,
      {} as never,
    );
    collector({
      type: 'tool_execution_end',
      toolName: tool.name,
      toolCallId: 'synthetic-write',
      result,
      isError: false,
    } as AgentSessionEvent);
    expect(memory).toHaveBeenCalledWith(
      {
        mode: 'remember',
        content: params.content,
        kind: 'preference',
        toolCallId: 'synthetic-write',
      },
      undefined,
    );
    expect(recordExecution.mock.calls[0][0].invocation.args).toEqual(params);
    expect(JSON.stringify(result)).toContain('synthetic-item');
    expect(JSON.stringify(result)).not.toContain(params.content);
    expect(JSON.stringify(result)).not.toContain(
      'HOST_READ_TEXT_MUST_NOT_RETURN',
    );
    expect(JSON.stringify(requestScope.traceEvents)).not.toContain(
      params.content,
    );
    expect(JSON.stringify(publishStreamEvent.mock.calls)).not.toContain(
      params.content,
    );
    expect(JSON.stringify(requestScope.transcript)).toContain(params.content);
  });

  it('uses separate recall and explicit editing switches, requires revision 1 and exposes no identity arguments', () => {
    const names = (memoryScope: MemoryRequestScope) =>
      tools(undefined, memoryScope).list.map((tool) => tool.name);
    expect(names({ ...scope, chatEditingEnabled: false })).toEqual([
      'search_memory',
      'get_memory_source',
    ]);
    expect(names({ ...scope, recallEnabled: false })).toEqual([
      'remember_memory',
      'update_memory',
      'forget_memory',
    ]);
    expect(
      names({ ...scope, recallEnabled: false, chatEditingEnabled: false }),
    ).toEqual([]);
    for (const tool of tools(undefined).list) {
      const schema = JSON.stringify(tool.parameters);
      expect(schema).not.toContain('ownerUserId');
      expect(schema).not.toContain('actorKey');
      expect(schema).not.toContain('audienceKey');
      if (schema.includes('revision'))
        expect(schema).toMatch(/"revision":\{[^}]*"minimum":1/);
    }
  });
});
