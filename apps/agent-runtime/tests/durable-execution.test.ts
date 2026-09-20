vi.mock('../src/result-spool.js', () => ({
  spoolResult: vi.fn(async () => '/synthetic/result'),
  removeSpooledResult: vi.fn(async () => {}),
  readSpooledResults: vi.fn(async () => []),
}));
import { afterEach, describe, expect, it, vi } from 'vitest';
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../src/agent-db.js', () => ({ getAgentDbPool: () => ({ query }) }));
vi.mock('../src/io.js', () => ({ log: vi.fn() }));
import {
  claimDurableExecution,
  deliverDurableResult,
  startDurableExecutionHeartbeat,
} from '../src/durable-execution.js';
import type { InboxRequest, OutboxResponse } from '../src/types.js';
const request = {
  requestId: 'r',
  executionId: 'e',
  accountId: 'a',
} as InboxRequest;
const response = {
  requestId: 'r',
  text: 'generated result',
  status: 'success',
  usage: { totalTokens: 7 },
} as OutboxResponse;
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});
describe('durable execution boundary', () => {
  it('keeps legacy requests compatible without touching PG', async () => {
    expect(
      await claimDurableExecution({ ...request, executionId: undefined }),
    ).toBe(true);
    expect(query).not.toHaveBeenCalled();
  });
  it('only grants one execution when the atomic claim succeeds', async () => {
    query
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0 });
    expect(await claimDurableExecution(request)).toBe(true);
    expect(await claimDurableExecution(request)).toBe(false);
    expect(query.mock.calls[0][0]).toContain('cancel_requested_at IS NULL');
    expect(query.mock.calls[0][0]).toContain('deadline_at>now()');
  });
  it('persists the generated result before publishing', async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });
    const push = vi.fn(async () => {
      expect(query).toHaveBeenCalledTimes(1);
      expect(JSON.parse(query.mock.calls[0][1][3])).toEqual(response);
    });
    await deliverDurableResult(request, response, push);
    expect(push).toHaveBeenCalledWith('ipc:a:outbox', JSON.stringify(response));
    expect(query.mock.calls[0][0]).toContain(
      "state IN ('running','interrupted')",
    );
  });
  it('still delivers original output and usage if PG is unavailable', async () => {
    query.mockRejectedValueOnce(new Error('synthetic PG unavailable'));
    const push = vi.fn().mockResolvedValue(1);
    await deliverDurableResult(request, response, push);
    expect(push).toHaveBeenCalledWith('ipc:a:outbox', JSON.stringify(response));
  });
  it('leaves a persisted response for recovery when Redis fails', async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });
    await expect(
      deliverDurableResult(
        request,
        response,
        vi.fn().mockRejectedValue(new Error('synthetic Redis unavailable')),
      ),
    ).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('does not publish an already completed or fenced execution result', async () => {
    query
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{ execution_id: 'e', account_id: 'a', state: 'completed' }],
      });
    const push = vi.fn();
    await deliverDurableResult(request, response, push);
    expect(push).not.toHaveBeenCalled();
  });
  it('aborts when durable cancellation is set and stops heartbeat after disposal', async () => {
    vi.useFakeTimers();
    query.mockResolvedValue({ rowCount: 1, rows: [{ cancelled: true }] });
    const abort = vi.fn();
    const stop = startDurableExecutionHeartbeat(request, abort);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(abort).toHaveBeenCalledOnce();
    stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(query).toHaveBeenCalledOnce();
  });
});
