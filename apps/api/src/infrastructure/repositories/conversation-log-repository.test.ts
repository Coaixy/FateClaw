import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetDbPool } = vi.hoisted(() => ({
  mockGetDbPool: vi.fn(),
}));

vi.mock('../db-pool.js', () => ({
  getDbPool: mockGetDbPool,
}));

import {
  getConversationLogSummaries,
  purgeExpiredTraceEvents,
  storeConversationLog,
} from './conversation-log-repository.js';

interface QueryCall {
  sql: string;
  params?: unknown[];
}

function createMockPool(options?: { rows?: unknown[]; rowCounts?: number[] }) {
  const calls: QueryCall[] = [];
  const clientCalls: QueryCall[] = [];
  const rowCounts = [...(options?.rowCounts ?? [])];
  const client = {
    async query(sql: string, params?: unknown[]) {
      clientCalls.push({ sql, params });
      return {
        rows: options?.rows ?? [],
        rowCount: rowCounts.shift() ?? 0,
      };
    },
    release: vi.fn(),
  };
  const pool = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      return {
        rows: options?.rows ?? [],
        rowCount: rowCounts.shift() ?? 0,
      };
    },
    async connect() {
      return client;
    },
  };
  mockGetDbPool.mockReturnValue(pool);
  return { calls, clientCalls, client };
}

describe('conversation log repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stores summary metadata and payload rows in one transaction', async () => {
    const { clientCalls, client } = createMockPool();
    const traceEvents = [
      {
        type: 'contract_requirement_registered',
        runId: 'run-1',
        attemptId: 'attempt-1',
        requirementId: 'req-1',
        provider: 'openai-compatible',
        model: 'test-model',
        payload: { capability: 'knowledge', targets: [] },
      },
    ];

    await storeConversationLog({
      id: 'log-1',
      accountId: 'web:user-1',
      requestId: 'request-1',
      transcript: [{ type: 'message' }, { type: 'tool_use' }],
      usage: { input_tokens: 1 },
      model: 'test-model',
      provider: 'openai-compatible',
      traceEvents,
      agentGraph: { summary: { nodes: 1 }, raw: true },
    });

    expect(clientCalls[0]?.sql).toBe('BEGIN');
    expect(clientCalls[1]?.sql).toContain('INSERT INTO conversation_logs');
    expect(clientCalls[1]?.params?.slice(0, 9)).toEqual([
      'log-1',
      'web:user-1',
      'request-1',
      JSON.stringify({ input_tokens: 1 }),
      'test-model',
      'openai-compatible',
      2,
      1,
      1,
    ]);
    expect(clientCalls[1]?.params?.[9]).toBe(JSON.stringify({ nodes: 1 }));
    expect(clientCalls[1]?.params?.[10]).toEqual(expect.any(String));
    expect(clientCalls[2]?.sql).toContain(
      'INSERT INTO conversation_log_payloads',
    );
    expect(clientCalls[2]?.params).toEqual([
      'log-1',
      JSON.stringify([{ type: 'message' }, { type: 'tool_use' }]),
      JSON.stringify(traceEvents),
      JSON.stringify({ summary: { nodes: 1 }, raw: true }),
    ]);
    expect(clientCalls[3]?.sql).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('builds summary pagination filters without selecting payload columns', async () => {
    const { calls } = createMockPool();

    await getConversationLogSummaries(
      'web:user-1',
      20,
      '2026-05-27T00:00:00.000Z',
    );

    expect(calls[0]?.sql).toContain('FROM conversation_logs');
    expect(calls[0]?.sql).not.toContain('conversation_log_payloads');
    expect(calls[0]?.sql).toContain('created_at < $3');
    expect(calls[0]?.params).toEqual([
      'web:user-1',
      20,
      '2026-05-27T00:00:00.000Z',
    ]);
  });

  it('purges trace events in batches until the last partial batch', async () => {
    const { calls } = createMockPool({ rowCounts: [1000, 12] });

    await expect(purgeExpiredTraceEvents(7)).resolves.toBe(1012);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.sql).toContain('UPDATE conversation_log_payloads');
    expect(calls[0]?.params).toEqual([7, 1000]);
    expect(calls[1]?.params).toEqual([7, 1000]);
  });
});
