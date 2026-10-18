import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
  claim: vi.fn(),
  complete: vi.fn(),
  runtime: vi.fn(),
  probe: vi.fn(),
  benefitProbe: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('#infrastructure/repositories/service-status-repository', () => ({
  claimServiceStatusCheck: f.claim,
  completeServiceStatusCheck: f.complete,
}));
vi.mock('#modules/system/system-config', () => ({
  resolveOfficialLlmRuntime: f.runtime,
}));
vi.mock('#modules/system/model-availability-probe', () => ({
  probeModelAvailability: f.probe,
  probeBenefitModelAvailability: f.benefitProbe,
}));
vi.mock('#infrastructure/logger', () => ({
  logger: { warn: f.warn },
}));
import type { RuntimeModelPoolNode } from '@fateclaw/contracts/model-settings';
const nodes: RuntimeModelPoolNode[] = ['a', 'b', 'c'].map((id) => ({
  modelConfigId: id,
  revision: 1,
  weight: 1,
  piApi: 'openai-completions',
  model: 'synthetic',
  providerKey: id,
  authMode: 'openai_api_key',
  apiKey: 'synthetic-key',
}));
let worker: typeof import('#runtime/service-status-worker');
beforeEach(async () => {
  vi.resetAllMocks();
  vi.resetModules();
  worker = await import('#runtime/service-status-worker');
  f.claim.mockImplementation(async (poolKey) =>
    poolKey === 'benefit' ? null : 'lease',
  );
  f.runtime.mockResolvedValue({ poolNodes: nodes });
  f.complete.mockResolvedValue(undefined);
});
afterEach(async () => {
  await worker.stopServiceStatusWorker();
});

describe('shared service status worker', () => {
  it('stops as soon as one node is available and publishes no node identity', async () => {
    f.probe.mockResolvedValueOnce(null).mockResolvedValueOnce(37);
    expect(
      await worker.checkServiceAvailability(
        nodes,
        new AbortController().signal,
      ),
    ).toEqual({ status: 'operational', latency_ms: 37 });
    expect(f.probe).toHaveBeenCalledTimes(2);
  });
  it('reports unavailable only after all candidates fail', async () => {
    f.probe.mockResolvedValue(null);
    expect(
      await worker.checkServiceAvailability(
        nodes,
        new AbortController().signal,
      ),
    ).toEqual({ status: 'unavailable', latency_ms: null });
    expect(f.probe).toHaveBeenCalledTimes(3);
  });
  it('performs no inference when the pool is unconfigured or the check is cancelled', async () => {
    expect(
      await worker.checkServiceAvailability([], new AbortController().signal),
    ).toEqual({ status: 'unavailable', latency_ms: null });
    expect(
      await worker.checkServiceAvailability(nodes, AbortSignal.abort()),
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
    expect(f.complete).toHaveBeenCalledWith('lease', {
      status: 'operational',
      latency_ms: 23,
      checked_at: expect.any(String),
    });
  });
  it('does not load credentials or probe when the shared interval is not due', async () => {
    f.claim.mockResolvedValue(null);
    await worker.runServiceStatusCheckOnce();
    expect(f.runtime).not.toHaveBeenCalled();
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
    expect(f.runtime).not.toHaveBeenCalled();
    expect(f.probe).not.toHaveBeenCalled();
    expect(f.complete).toHaveBeenCalledWith(
      'lease',
      expect.objectContaining({ status: 'unknown' }),
    );
  });
});
