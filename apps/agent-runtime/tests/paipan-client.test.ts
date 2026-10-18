import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAIPAN_RPC_TIMEOUT_MS } from '@fateclaw/contracts/agent/paipan';

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
