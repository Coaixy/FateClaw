import type pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetDbPool } = vi.hoisted(() => ({
  mockGetDbPool: vi.fn(),
}));

vi.mock('../../../src/infrastructure/db-pool.js', () => ({
  getDbPool: mockGetDbPool,
}));

import {
  deleteConversationLogsByAccountIds,
  getConversationLogSummaries,
  purgeExpiredTraceEvents,
  storeConversationLog,
} from '../../../src/infrastructure/repositories/conversation-log-repository.js';

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

  it('joins the result transaction without committing or releasing its client', async () => {
    const { clientCalls, client } = createMockPool();
    mockGetDbPool.mockClear();
    await storeConversationLog(
      { id: 'log', accountId: 'account', requestId: 'request', transcript: [] },
      client as unknown as pg.PoolClient,
    );
    expect(clientCalls).toHaveLength(2);
    expect(clientCalls.every((call) => call.sql.includes('INSERT INTO'))).toBe(
      true,
    );
    expect(client.release).not.toHaveBeenCalled();
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('stores summary metadata and payload rows in one transaction', async () => {
    const { clientCalls, client } = createMockPool();
    const traceEvents = [{ type: 'pi_context_loaded' }];

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
    expect(clientCalls[1]?.params?.[10]).toBeNull();
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

  it('stores only the pi session snapshot when provided', async () => {
    const { clientCalls } = createMockPool();

    await storeConversationLog({
      id: 'log-1',
      accountId: 'web:user-1',
      requestId: 'request-1',
      transcript: [],
      traceEvents: [{ type: 'pi_turn_start' }, { type: 'pi_turn_end' }],
      piSession: {
        id: 'session-1',
        file: '/tmp/session.json',
        persisted: true,
        messageCount: 2,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(clientCalls[1]?.params?.[6]).toBe(0);
    expect(clientCalls[1]?.params?.[7]).toBe(0);
    expect(clientCalls[1]?.params?.[8]).toBe(1);
    expect(clientCalls[2]?.params?.[1]).toBe(JSON.stringify([]));
    const storedTraceEvents = JSON.parse(clientCalls[2]?.params?.[2] as string);
    expect(storedTraceEvents).toEqual([
      {
        type: 'pi_session_snapshot',
        timestamp: expect.any(String),
        session: {
          id: 'session-1',
          file: '/tmp/session.json',
          persisted: true,
          messageCount: 2,
          messages: [{ role: 'user', content: 'hi' }],
        },
      },
    ]);
    expect(clientCalls[2]?.params?.[3]).toBeNull();
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

  it('deletes logs for multiple runtime accounts in one statement', async () => {
    const { calls } = createMockPool({ rowCounts: [5] });

    await expect(
      deleteConversationLogsByAccountIds(['web:user-1', 'account-1']),
    ).resolves.toBe(5);

    expect(calls[0]?.sql).toBe(
      'DELETE FROM conversation_logs WHERE account_id = ANY($1::text[])',
    );
    expect(calls[0]?.params).toEqual([['web:user-1', 'account-1']]);
  });

  it('skips the database when deleting logs for an empty account set', async () => {
    const { calls } = createMockPool();

    await expect(deleteConversationLogsByAccountIds([])).resolves.toBe(0);

    expect(calls).toHaveLength(0);
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
