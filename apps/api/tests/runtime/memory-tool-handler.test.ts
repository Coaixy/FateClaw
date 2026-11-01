import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MEMORY_RPC_TIMEOUT_MS,
  memoryRequestQueue,
  memoryResponseQueue,
  type MemoryIpcRequest,
} from '@fateclaw/contracts/agent/memory';

const { executeMemoryOperation, transaction, logger } = vi.hoisted(() => ({
  executeMemoryOperation: vi.fn(),
  transaction: { lpush: vi.fn(), expire: vi.fn(), exec: vi.fn() },
  logger: { error: vi.fn() },
}));
vi.mock('#modules/memory/service', () => ({ executeMemoryOperation }));
vi.mock('#infrastructure/redis', () => ({
  getRedis: () => ({ multi: () => transaction }),
}));
vi.mock('#infrastructure/logger', () => ({ logger }));
vi.mock('#infrastructure/config', () => ({
  JWT_SECRET: 'synthetic-memory-handler-root',
}));

import { MemoryError } from '#modules/memory/domain';
import { decodeRuntimeIpc, encodeRuntimeIpc } from '#runtime/ipc-security';
import { processMemoryToolPayload } from '#runtime/memory-tool-handler';

const accountId = 'web:synthetic-memory-user';
const request = (): MemoryIpcRequest => ({
  rpcId: randomUUID(),
  requestId: 'synthetic-request',
  executionId: 'synthetic-execution',
  operation: {
    mode: 'read',
    references: [{ kind: 'item', id: 'synthetic-item', revision: 1 }],
  },
});

beforeEach(() => {
  vi.resetAllMocks();
  transaction.lpush.mockReturnValue(transaction);
  transaction.expire.mockReturnValue(transaction);
  transaction.exec.mockResolvedValue([
    [null, 1],
    [null, 1],
  ]);
});
afterEach(() => {
  vi.useRealTimers();
});

function reply() {
  const [queue, envelope] = transaction.lpush.mock.calls[0];
  return {
    queue,
    envelope,
    data: JSON.parse(decodeRuntimeIpc(accountId, queue, envelope)),
  };
}

describe('memory tool RPC handler', () => {
  it('returns hydrated text only in an authenticated encrypted reply with a finite lifetime', async () => {
    const requestQueue = memoryRequestQueue(accountId);
    const payload = JSON.parse(
      decodeRuntimeIpc(
        accountId,
        requestQueue,
        encodeRuntimeIpc(
          accountId,
          requestQueue,
          JSON.stringify(request()),
          MEMORY_RPC_TIMEOUT_MS,
        ),
      ),
    ) as MemoryIpcRequest;
    const result = {
      ok: true,
      mode: 'read',
      hydration: {
        status: 'ready',
        epoch: 1,
        contextGeneration: 1,
        tokenBudget: 2000,
        excerpts: [
          {
            reference:
              payload.operation.mode === 'read'
                ? payload.operation.references[0]
                : undefined,
            text: 'SYNTHETIC_PRIVATE_HYDRATION_BODY',
            label: 'Synthetic evidence',
          },
        ],
      },
    };
    executeMemoryOperation.mockResolvedValueOnce(result);
    vi.useFakeTimers();
    await processMemoryToolPayload(payload, accountId);
    const output = reply();
    expect(executeMemoryOperation).toHaveBeenCalledWith(accountId, payload);
    expect(output.queue).toBe(memoryResponseQueue(accountId, payload.rpcId));
    expect(output.envelope).not.toContain('SYNTHETIC_PRIVATE_HYDRATION_BODY');
    expect(output.data).toMatchObject({ rpcId: payload.rpcId, result });
    expect(transaction.expire).toHaveBeenCalledWith(
      output.queue,
      MEMORY_RPC_TIMEOUT_MS / 1000,
    );
    expect(logger.error).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + MEMORY_RPC_TIMEOUT_MS + 1);
    expect(() =>
      decodeRuntimeIpc(accountId, output.queue, output.envelope),
    ).toThrow();
  });

  it('preserves a known domain rejection without logging input or source content', async () => {
    executeMemoryOperation.mockRejectedValueOnce(
      new MemoryError(
        '记忆请求已结束或未获得授权',
        403,
        'MEMORY.REQUEST_INACTIVE',
      ),
    );
    await processMemoryToolPayload(request(), accountId);
    expect(reply().data.result).toEqual({
      ok: false,
      code: 'MEMORY.REQUEST_INACTIVE',
      error: '记忆请求已结束或未获得授权',
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('reports unknown failures through a generic result and metadata-only logs', async () => {
    executeMemoryOperation.mockRejectedValueOnce(
      new Error('SYNTHETIC_PRIVATE_SQL_AND_SOURCE_BODY'),
    );
    await processMemoryToolPayload(request(), accountId);
    expect(reply().data.result).toMatchObject({
      ok: false,
      code: 'MEMORY.UNAVAILABLE',
    });
    expect(JSON.stringify(reply().data)).not.toContain(
      'SYNTHETIC_PRIVATE_SQL_AND_SOURCE_BODY',
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(
      'SYNTHETIC_PRIVATE_SQL_AND_SOURCE_BODY',
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId,
        requestId: 'synthetic-request',
        errorType: 'Error',
      }),
      expect.any(String),
    );
  });

  it('rejects invalid envelopes before execution and reports a failed reply commit', async () => {
    await expect(
      processMemoryToolPayload(
        { ...request(), operation: { mode: 'invalid' } },
        accountId,
      ),
    ).rejects.toThrow('Invalid memory tool request');
    expect(executeMemoryOperation).not.toHaveBeenCalled();
    expect(transaction.lpush).not.toHaveBeenCalled();
    executeMemoryOperation.mockResolvedValueOnce({
      ok: true,
      mode: 'forget',
      forgottenId: 'synthetic-item',
    });
    transaction.exec.mockResolvedValueOnce([
      [new Error('SYNTHETIC_BROKER_DIAGNOSTIC'), null],
    ]);
    await expect(
      processMemoryToolPayload(request(), accountId),
    ).rejects.toThrow('Memory reply was not committed');
  });
});
