import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAIPAN_RPC_TIMEOUT_MS } from '@fateclaw/contracts/agent/paipan';
import { MEMORY_RPC_TIMEOUT_MS } from '@fateclaw/contracts/agent/memory';

const { getRedis, consumer, transaction } = vi.hoisted(() => ({
  getRedis: vi.fn(),
  consumer: {
    connect: vi.fn(),
    on: vi.fn(),
    brpop: vi.fn(),
    disconnect: vi.fn(),
  },
  transaction: { lpush: vi.fn(), expire: vi.fn(), exec: vi.fn() },
}));
vi.mock('#agent/redis', () => ({ getRedis }));
import { createPaipanCaller } from '#agent/paipan-client';
import { createHostToolCaller } from '#agent/host-tool-client';
import { decodeAgentIpc, encodeAgentIpc } from '#agent/ipc-security';

const identity = {
  accountId: 'web:synthetic-user',
  requestId: 'synthetic-request',
  executionId: 'synthetic-execution',
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubEnv('FATECLAW_IPC_KEY', 'a'.repeat(64));
  let rejectRead!: (error: Error) => void;
  consumer.connect.mockResolvedValue(undefined);
  consumer.brpop.mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        rejectRead = reject;
      }),
  );
  consumer.disconnect.mockImplementation(() =>
    rejectRead?.(new Error('Synthetic disconnected socket')),
  );
  transaction.lpush.mockReturnValue(transaction);
  transaction.expire.mockReturnValue(transaction);
  transaction.exec.mockResolvedValue([
    [null, 1],
    [null, 1],
  ]);
  getRedis.mockReturnValue({
    duplicate: vi.fn(() => consumer),
    multi: () => transaction,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('paipan RPC lifetime', () => {
  it('times out a missing host response and releases its dedicated blocking connection', async () => {
    const response = createPaipanCaller(identity)({ mode: 'catalog' });
    await vi.advanceTimersByTimeAsync(0);
    expect(transaction.expire).toHaveBeenCalledWith(
      'ipc:web:synthetic-user:paipan',
      30,
    );
    await vi.advanceTimersByTimeAsync(PAIPAN_RPC_TIMEOUT_MS);
    expect(await response).toMatchObject({ ok: false, code: 'PAIPAN.TIMEOUT' });
    expect(consumer.disconnect).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts an in-flight read without waiting for the host deadline', async () => {
    const controller = new AbortController();
    const response = createPaipanCaller(identity)(
      { mode: 'catalog' },
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await response).toMatchObject({
      ok: false,
      code: 'PAIPAN.CANCELLED',
    });
    expect(consumer.disconnect).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not enqueue work when cancellation predates the call', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await createPaipanCaller(identity)(
        { mode: 'catalog' },
        controller.signal,
      ),
    ).toMatchObject({ ok: false, code: 'PAIPAN.CANCELLED' });
    expect(getRedis).not.toHaveBeenCalled();
  });
});

describe('memory host RPC', () => {
  it('uses the signed memory channel, keeps only contract fields of hydrations and strips host error text', async () => {
    let hostError = false;
    consumer.brpop.mockImplementation(async (replyQueue) => {
      const [queue, encoded] = transaction.lpush.mock.calls.at(-1)!;
      const request = JSON.parse(decodeAgentIpc(queue, encoded));
      expect(queue).toBe('ipc:web:synthetic-user:memory');
      expect(request).toMatchObject({
        requestId: identity.requestId,
        executionId: identity.executionId,
        operation: { mode: 'search', query: 'Synthetic query' },
      });
      const result = hostError
        ? {
            ok: false,
            code: 'MEMORY.REVISION_CHANGED',
            error: 'PRIVATE_ERROR_BODY',
          }
        : {
            ok: true,
            mode: 'search',
            hydration: {
              status: 'ready',
              epoch: 1,
              contextGeneration: 0,
              tokenBudget: 2000,
              excerpts: [
                {
                  reference: {
                    kind: 'item',
                    id: 'synthetic-item',
                    revision: 1,
                  },
                  text: 'Synthetic excerpt',
                  label: 'Fact',
                  unexpected: 'PRIVATE_EXTRA_FIELD',
                },
                {
                  reference: {
                    kind: 'item',
                    id: 'extra-key-item',
                    revision: 1,
                    text: 'PRIVATE_READ_BODY',
                  },
                  text: 'Rejected reference',
                  label: 'Fact',
                },
              ],
            },
            text: 'PRIVATE_READ_BODY',
          };
      return [
        replyQueue,
        encodeAgentIpc(
          replyQueue,
          JSON.stringify({ rpcId: request.rpcId, result }),
          MEMORY_RPC_TIMEOUT_MS,
        ),
      ];
    });
    const memory = createHostToolCaller('memory', identity);
    const result = await memory({ mode: 'search', query: 'Synthetic query' });
    expect(result).toEqual({
      ok: true,
      mode: 'search',
      hydration: {
        status: 'ready',
        epoch: 1,
        contextGeneration: 0,
        tokenBudget: 2000,
        excerpts: [
          {
            reference: { kind: 'item', id: 'synthetic-item', revision: 1 },
            text: 'Synthetic excerpt',
            label: 'Fact',
          },
        ],
      },
    });
    hostError = true;
    const failure = await memory({ mode: 'search', query: 'Synthetic query' });
    expect(failure).toMatchObject({
      ok: false,
      code: 'MEMORY.REVISION_CHANGED',
    });
    expect(JSON.stringify(failure)).not.toContain('PRIVATE_ERROR_BODY');
  });

  it('bounds memory waits and releases the blocking connection on cancellation', async () => {
    const response = createHostToolCaller(
      'memory',
      identity,
    )({ mode: 'prepare', references: [] });
    await vi.advanceTimersByTimeAsync(MEMORY_RPC_TIMEOUT_MS);
    expect(await response).toMatchObject({ ok: false, code: 'MEMORY.TIMEOUT' });
    const controller = new AbortController();
    const cancelled = createHostToolCaller('memory', identity)(
      { mode: 'prepare', references: [] },
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await cancelled).toMatchObject({
      ok: false,
      code: 'MEMORY.CANCELLED',
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
