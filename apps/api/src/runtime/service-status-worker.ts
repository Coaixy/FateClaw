import type { ServiceStatusSampleDto } from '@fateclaw/contracts/service-status';
import type { RuntimeModelPoolNode } from '@fateclaw/contracts/model-settings';
import {
  claimServiceStatusCheck,
  completeServiceStatusCheck,
} from '../infrastructure/repositories/service-status-repository.js';
import { resolveOfficialLlmRuntime } from '../modules/system/system-config.js';
import { probeModelAvailability } from '../modules/system/model-availability-probe.js';
import { logger } from '../infrastructure/logger.js';

export async function checkServiceAvailability(
  nodes: RuntimeModelPoolNode[],
  signal: AbortSignal,
  probe = probeModelAvailability,
): Promise<Pick<ServiceStatusSampleDto, 'status' | 'latency_ms'>> {
  for (const node of nodes) {
    if (signal.aborted) return { status: 'unknown', latency_ms: null };
    const latency = await probe(node, signal);
    if (signal.aborted) return { status: 'unknown', latency_ms: null };
    if (latency !== null) return { status: 'operational', latency_ms: latency };
  }
  return {
    status: signal.aborted ? 'unknown' : 'unavailable',
    latency_ms: null,
  };
}

let timer: NodeJS.Timeout | undefined;
let active: Promise<void> | undefined;
let controller: AbortController | undefined;
let stopping = false;

export async function runServiceStatusCheckOnce(): Promise<void> {
  if (active) return active;
  active = (async () => {
    const token = await claimServiceStatusCheck();
    if (!token) return;
    controller = new AbortController();
    const budget = AbortSignal.timeout(180_000);
    const signal = AbortSignal.any([controller.signal, budget]);
    let sample: Pick<ServiceStatusSampleDto, 'status' | 'latency_ms'> = {
      status: 'unknown',
      latency_ms: null,
    };
    try {
      if (!stopping) {
        const runtime = await resolveOfficialLlmRuntime();
        sample = await checkServiceAvailability(
          runtime?.poolNodes ?? [],
          signal,
        );
      }
    } catch {
      logger.warn(
        'AI service status check failed; recording an unknown result',
      );
    }
    await completeServiceStatusCheck(token, {
      ...sample,
      checked_at: new Date().toISOString(),
    });
  })();
  try {
    await active;
  } finally {
    active = undefined;
    controller = undefined;
  }
}

export function startServiceStatusWorker(): void {
  if (timer) return;
  stopping = false;
  const tick = () => {
    void runServiceStatusCheckOnce().catch(() =>
      logger.warn(
        'AI service status update failed; retained until the next scheduled check',
      ),
    );
  };
  timer = setInterval(tick, 5 * 60_000);
  timer.unref();
  tick();
}

export async function stopServiceStatusWorker(): Promise<void> {
  stopping = true;
  if (timer) clearInterval(timer);
  timer = undefined;
  controller?.abort();
  await active;
}
