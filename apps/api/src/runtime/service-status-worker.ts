import type { ServiceStatusSampleDto } from '@fateclaw/contracts/service-status';
import {
  claimServiceStatusCheck,
  completeServiceStatusCheck,
} from '#infrastructure/repositories/service-status-repository';
import { listServiceStatusNodes } from '#modules/system/system-config';
import {
  modelNetworkProbeOrigin,
  probeModelNetwork,
} from '#modules/system/model-availability-probe';
import { logger } from '#infrastructure/logger';

export async function checkServiceNetwork(
  origins: string[],
  signal: AbortSignal,
  probe = probeModelNetwork,
): Promise<Pick<ServiceStatusSampleDto, 'status' | 'latency_ms'>> {
  for (const origin of new Set(origins)) {
    if (signal.aborted) return { status: 'unknown', latency_ms: null };
    const latency = await probe(origin, signal);
    if (signal.aborted) return { status: 'unknown', latency_ms: null };
    if (latency !== null) return { status: 'operational', latency_ms: latency };
  }
  return {
    status: signal.aborted || !origins.length ? 'unknown' : 'unavailable',
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
    for (const poolKey of ['official', 'benefit'] as const) {
      if (stopping) break;
      const token = await claimServiceStatusCheck(poolKey);
      if (!token) continue;
      controller = new AbortController();
      const budget = AbortSignal.timeout(180_000);
      const signal = AbortSignal.any([controller.signal, budget]);
      let sample: Pick<ServiceStatusSampleDto, 'status' | 'latency_ms'> = {
        status: 'unknown',
        latency_ms: null,
      };
      try {
        if (!stopping) {
          const nodes = await listServiceStatusNodes(poolKey);
          const origins = nodes
            .map(modelNetworkProbeOrigin)
            .filter((origin) => origin !== null);
          sample = await checkServiceNetwork(origins, signal);
        }
      } catch {
        logger.warn(
          'AI service status check failed; recording an unknown result',
        );
      }
      const result = {
        ...sample,
        checked_at: new Date().toISOString(),
      };
      await completeServiceStatusCheck(token, result, poolKey);
    }
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
