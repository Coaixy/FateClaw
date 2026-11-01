import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MEMORY_RUNTIME_POLICY } from '@fateclaw/contracts/memory';
import type { MemoryJobRow } from '#modules/memory/domain';

const mocks = vi.hoisted(() => ({
  policy: vi.fn(),
  claim: vi.fn(),
  process: vi.fn(),
  warn: vi.fn(),
  reconcile: vi.fn(),
  prune: vi.fn(),
}));
vi.mock('#infrastructure/logger', () => ({ logger: { warn: mocks.warn } }));
vi.mock('#modules/memory/policy', () => ({
  getMemoryRuntimePolicy: mocks.policy,
}));
vi.mock('#modules/memory/jobs', () => ({
  claimMemoryJobs: mocks.claim,
  processMemoryJob: mocks.process,
  pruneFinishedMemoryJobs: mocks.prune,
}));
vi.mock('#modules/memory/budget', () => ({
  reconcileMemoryBudgetReservations: mocks.reconcile,
}));

let worker: typeof import('#runtime/memory-worker');
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  worker = await import('#runtime/memory-worker');
  mocks.policy.mockResolvedValue({
    ...DEFAULT_MEMORY_RUNTIME_POLICY,
    worker_concurrency: 2,
  });
  mocks.claim.mockResolvedValue([]);
  mocks.process.mockResolvedValue(undefined);
  mocks.reconcile.mockResolvedValue(0);
  mocks.prune.mockResolvedValue(0);
});
afterEach(async () => {
  await worker.stopMemoryWorker();
});

describe('persistent memory worker scheduling', () => {
  it('does not claim jobs while disabled', async () => {
    mocks.policy.mockResolvedValue({
      ...DEFAULT_MEMORY_RUNTIME_POLICY,
      enabled: false,
    });
    await worker.runMemoryWorkerOnce();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.reconcile).toHaveBeenCalledTimes(1);
  });

  it('uses current policy concurrency and reuses the active run during overlapping ticks', async () => {
    const releases: Array<() => void> = [];
    mocks.claim.mockResolvedValue([
      { id: 'job-1' },
      { id: 'job-2' },
    ] as MemoryJobRow[]);
    mocks.process.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
    );
    const first = worker.runMemoryWorkerOnce();
    const second = worker.runMemoryWorkerOnce();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(mocks.process).toHaveBeenCalledTimes(2));
    expect(mocks.claim).toHaveBeenCalledWith(
      expect.objectContaining({ worker_concurrency: 2 }),
      2,
    );
    releases.forEach((resolve) => resolve());
    await Promise.all([first, second]);
  });

  it('waits for cancellation-aware processors on stop and does not start a second claim', async () => {
    mocks.claim.mockResolvedValue([{ id: 'job-1' }] as MemoryJobRow[]);
    mocks.process.mockImplementation(
      (_job, _policy, options) =>
        new Promise<void>((resolve) => {
          options.signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
        }),
    );
    const run = worker.runMemoryWorkerOnce();
    await vi.waitFor(() => expect(mocks.process).toHaveBeenCalled());
    await worker.stopMemoryWorker();
    await run;
    await worker.runMemoryWorkerOnce();
    expect(mocks.claim).toHaveBeenCalledTimes(1);
  });

  it('reports only safe job identifiers/codes at the unexpected error recovery boundary', async () => {
    mocks.claim.mockResolvedValue([{ id: 'job-1' }] as MemoryJobRow[]);
    mocks.process.mockRejectedValue(
      new Error('synthetic-private-upstream-body'),
    );
    await worker.runMemoryWorkerOnce();
    expect(mocks.warn).toHaveBeenCalledWith(
      { jobId: 'job-1', code: 'MEMORY.UNEXPECTED' },
      expect.any(String),
    );
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain(
      'synthetic-private-upstream-body',
    );
  });

  it('finishes recovery before claiming and cancels recovery at shutdown without claiming work', async () => {
    let entered = false;
    mocks.reconcile.mockImplementation(
      (_policy, options) =>
        new Promise<number>((resolve) => {
          entered = true;
          options.signal.addEventListener('abort', () => resolve(0), {
            once: true,
          });
        }),
    );
    const run = worker.runMemoryWorkerOnce();
    await vi.waitFor(() => expect(entered).toBe(true));
    expect(mocks.claim).not.toHaveBeenCalled();
    await worker.stopMemoryWorker();
    await run;
    expect(mocks.claim).not.toHaveBeenCalled();
  });
});
