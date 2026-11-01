import { describe, expect, it } from 'vitest';
import { isMemoryIpcRequest } from '../src/agent/memory.js';

const request = (operation: unknown) => ({
  rpcId: '11111111-1111-4111-8111-111111111111',
  requestId: 'request',
  executionId: 'execution',
  operation,
});

describe('memory RPC boundary', () => {
  it('accepts bounded reads and source pagination but rejects invented identity and malformed references', () => {
    const read = {
      mode: 'read',
      references: [
        { kind: 'source', id: 'source', revision: 1, offset: 400, limit: 400 },
      ],
    };
    expect(isMemoryIpcRequest(request(read))).toBe(true);
    expect(
      isMemoryIpcRequest(request({ ...read, ownerUserId: 'another-user' })),
    ).toBe(false);
    for (const reference of [
      { kind: 'source', id: 'source', revision: 0 },
      { kind: 'source', id: 'source', revision: 1, offset: -1 },
      { kind: 'soul', id: 'user', revision: 1 },
      { kind: 'projection', id: 'core', revision: 1 },
    ])
      expect(
        isMemoryIpcRequest(request({ ...read, references: [reference] })),
      ).toBe(false);
    expect(
      isMemoryIpcRequest(
        request({
          mode: 'prepare',
          query: '',
          references: Array.from({ length: 101 }, () => read.references[0]),
        }),
      ),
    ).toBe(false);
    expect(
      isMemoryIpcRequest({
        ...request({ mode: 'prepare', references: [] }),
        rpcId: '------------------------------------',
      }),
    ).toBe(false);
  });

  it('rejects calendar dates that Date.parse rolls over', () => {
    const search = (after: string) =>
      isMemoryIpcRequest(request({ mode: 'search', query: '考研', after }));
    expect(search('2024-02-29T00:00:00Z')).toBe(true);
    expect(search('2026-01-01T08:30:00+08:00')).toBe(true);
    expect(search('2024-02-30T00:00:00Z')).toBe(false);
    expect(search('2023-02-29T00:00:00Z')).toBe(false);
    expect(search('2026-01-01T24:00:00Z')).toBe(false);
  });

  it('validates mutation intent fields without permitting stale identity fields', () => {
    expect(
      isMemoryIpcRequest(
        request({
          mode: 'remember',
          content: '我准备考研。',
          kind: 'plan',
          toolCallId: 'call',
        }),
      ),
    ).toBe(true);
    expect(
      isMemoryIpcRequest(
        request({ mode: 'remember', content: '', toolCallId: 'call' }),
      ),
    ).toBe(false);
    expect(
      isMemoryIpcRequest(
        request({
          mode: 'remember',
          content: '我准备考研。',
          toolCallId: 'call',
          scopeId: 'other-scope',
        }),
      ),
    ).toBe(false);
    expect(
      isMemoryIpcRequest(
        request({
          mode: 'forget',
          id: 'item',
          revision: 1.5,
          toolCallId: 'call',
        }),
      ),
    ).toBe(false);
    for (const mode of ['check', 'recall', 'hydrate', 'read_soul', 'edit_soul'])
      expect(isMemoryIpcRequest(request({ mode }))).toBe(false);
  });
});
