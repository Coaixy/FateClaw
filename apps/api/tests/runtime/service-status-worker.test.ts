import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
  claim: vi.fn(),
  complete: vi.fn(),
  listNodes: vi.fn(),
  probe: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('#infrastructure/repositories/service-status-repository', () => ({
  claimServiceStatusCheck: f.claim,
  completeServiceStatusCheck: f.complete,
}));
vi.mock('#modules/system/system-config', () => ({
  listServiceStatusNodes: f.listNodes,
}));
vi.mock('#modules/system/model-availability-probe', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('#modules/system/model-availability-probe')
  >()),
  probeModelNetwork: f.probe,
}));
vi.mock('#infrastructure/logger', () => ({
  logger: { warn: f.warn },
}));
const origins = ['a', 'b', 'c'].map((id) => `https://${id}.invalid`);
const nodes = origins.map((origin) => ({
  pi_api: 'openai-completions' as const,
  base_url: `${origin}/v1`,
}));
let worker: typeof import('#runtime/service-status-worker');
beforeEach(async () => {
  vi.resetAllMocks();
  vi.resetModules();
  worker = await import('#runtime/service-status-worker');
  f.claim.mockImplementation(async (poolKey) =>
    poolKey === 'benefit' ? null : 'lease',
  );
  f.listNodes.mockResolvedValue(nodes);
  f.complete.mockResolvedValue(undefined);
});
afterEach(async () => {
  await worker.stopServiceStatusWorker();
});

describe('shared service status worker', () => {
  it('checks each origin at most once and stops at the first response', async () => {
    f.probe.mockResolvedValueOnce(null).mockResolvedValueOnce(37);
    expect(
      await worker.checkServiceNetwork(
        [origins[0], ...origins],
        new AbortController().signal,
      ),
    ).toEqual({ status: 'operational', latency_ms: 37 });
    expect(f.probe.mock.calls.map(([origin]) => origin)).toEqual(
      origins.slice(0, 2),
    );
  });
  it('reports unavailable only after all candidates fail', async () => {
    f.probe.mockResolvedValue(null);
    expect(
      await worker.checkServiceNetwork(origins, new AbortController().signal),
    ).toEqual({ status: 'unavailable', latency_ms: null });
    expect(f.probe).toHaveBeenCalledTimes(3);
  });
  it('reports unknown without probing an unconfigured pool or a cancelled check', async () => {
    expect(
      await worker.checkServiceNetwork([], new AbortController().signal),
    ).toEqual({ status: 'unknown', latency_ms: null });
    expect(
      await worker.checkServiceNetwork(origins, AbortSignal.abort()),
    ).toEqual({ status: 'unknown', latency_ms: null });
    expect(f.probe).not.toHaveBeenCalled();
  });
  it('coalesces overlapping local ticks into one persisted check', async () => {
    f.probe.mockResolvedValue(23);
    await Promise.all([
      worker.runServiceStatusCheckOnce(),
      worker.runServiceStatusCheckOnce(),
      worker.runServiceStatusCheckOnce(),
    ]);
    expect(f.claim).toHaveBeenCalledTimes(2);
    expect(f.claim).toHaveBeenCalledWith('benefit');
    expect(f.probe).toHaveBeenCalledOnce();
    expect(f.complete).toHaveBeenCalledWith(
      'lease',
      { status: 'operational', latency_ms: 23, checked_at: expect.any(String) },
      'official',
    );
  });
  it('checks the free pool with the same network probe', async () => {
    f.claim.mockResolvedValueOnce(null).mockResolvedValueOnce('free-lease');
    f.probe.mockResolvedValueOnce(0);
    await worker.runServiceStatusCheckOnce();
    expect(f.listNodes).toHaveBeenCalledExactlyOnceWith('benefit');
    expect(f.probe).toHaveBeenCalledExactlyOnceWith(
      origins[0],
      expect.any(AbortSignal),
    );
    expect(f.complete).toHaveBeenCalledWith(
      'free-lease',
      { status: 'operational', latency_ms: 0, checked_at: expect.any(String) },
      'benefit',
    );
  });
  it('does not load nodes or probe when the shared interval is not due', async () => {
    f.claim.mockResolvedValue(null);
    await worker.runServiceStatusCheckOnce();
    expect(f.listNodes).not.toHaveBeenCalled();
    expect(f.probe).not.toHaveBeenCalled();
    expect(f.complete).not.toHaveBeenCalled();
  });
  it('does not start a probe when shutdown happens while acquiring the shared claim', async () => {
    let release!: (token: string) => void;
    f.claim.mockReturnValue(
      new Promise<string>((resolve) => {
        release = resolve;
      }),
    );
    const running = worker.runServiceStatusCheckOnce();
    const stopping = worker.stopServiceStatusWorker();
    release('lease');
    await Promise.all([running, stopping]);
    expect(f.listNodes).not.toHaveBeenCalled();
    expect(f.probe).not.toHaveBeenCalled();
    expect(f.complete).toHaveBeenCalledWith(
      'lease',
      expect.objectContaining({ status: 'unknown' }),
      'official',
    );
  });
});
