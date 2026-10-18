import type { ServiceStatusSampleDto } from '@fateclaw/contracts/service-status';
import type { RuntimeModelPoolNode } from '@fateclaw/contracts/model-settings';
import {
  claimServiceStatusCheck,
  completeServiceStatusCheck,
} from '#infrastructure/repositories/service-status-repository';
import { resolveOfficialLlmRuntime } from '#modules/system/system-config';
import {
  probeModelAvailability,
  probeBenefitModelAvailability,
} from '#modules/system/model-availability-probe';
import { logger } from '#infrastructure/logger';

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
    for (const poolKey of ['official', 'benefit'] as const) {
      if (stopping) break;
      const token =
        poolKey === 'official'
          ? await claimServiceStatusCheck()
          : await claimServiceStatusCheck(poolKey);
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
          const runtime =
            poolKey === 'official'
              ? await resolveOfficialLlmRuntime()
              : await resolveOfficialLlmRuntime(poolKey);
          let skipped = false;
          sample = await checkServiceAvailability(
            runtime?.poolNodes ?? [],
            signal,
            poolKey === 'benefit'
              ? async (node, probeSignal) => {
                  const result = await probeBenefitModelAvailability(
                    node,
                    probeSignal,
                  );
                  if (!result.attempted) skipped = true;
                  return result.latency;
                }
              : probeModelAvailability,
          );
          if (
            poolKey === 'benefit' &&
            (!runtime || (skipped && sample.status !== 'operational'))
          )
            sample = { status: 'unknown', latency_ms: null };
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
      if (poolKey === 'official')
        await completeServiceStatusCheck(token, result);
      else await completeServiceStatusCheck(token, result, poolKey);
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
