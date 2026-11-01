import type { MemoryRuntimePolicy } from '@fateclaw/contracts/memory';
import { logger } from '#infrastructure/logger';
import { getMemoryRuntimePolicy } from '#modules/memory/policy';
import {
  claimMemoryJobs,
  processMemoryJob,
  pruneFinishedMemoryJobs,
  type MemoryJobOptions,
} from '#modules/memory/jobs';
import { MemoryError } from '#modules/memory/domain';
import { MemoryModelError } from '#modules/memory/model-client';
import { reconcileMemoryBudgetReservations } from '#modules/memory/budget';

export interface MemoryWorkerOptions extends MemoryJobOptions {
  getPolicy?: () => Promise<MemoryRuntimePolicy>;
  claim?: typeof claimMemoryJobs;
  process?: typeof processMemoryJob;
  reconcile?: typeof reconcileMemoryBudgetReservations;
  prune?: typeof pruneFinishedMemoryJobs;
}

const POLL_MS = 1_000;
const PRUNE_INTERVAL_MS = 3_600_000;
let lastPrunedAt = 0;
const STOP_WAIT_MS = 35_000;
let timer: NodeJS.Timeout | undefined;
let active: Promise<void> | undefined;
let controller: AbortController | undefined;
let stopping = false;

export function runMemoryWorkerOnce(
  options: MemoryWorkerOptions = {},
): Promise<void> {
  if (active) return active;
  if (stopping) return Promise.resolve();
  controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const operation = async () => {
    const policy = await (options.getPolicy ?? getMemoryRuntimePolicy)();
    if (signal.aborted) return;
    // Finish accounting for prior calls even when new memory processing is disabled.
    await (options.reconcile ?? reconcileMemoryBudgetReservations)(policy, {
      signal,
    });
    if (Date.now() - lastPrunedAt >= PRUNE_INTERVAL_MS) {
      lastPrunedAt = Date.now();
      await (options.prune ?? pruneFinishedMemoryJobs)({ signal });
    }
    if (!policy.enabled || signal.aborted) return;
    const jobs = await (options.claim ?? claimMemoryJobs)(
      policy,
      policy.worker_concurrency,
    );
    const results = await Promise.allSettled(
      jobs.map(async (job) => {
        if (signal.aborted) return;
        await (options.process ?? processMemoryJob)(job, policy, {
          ...options,
          signal,
        });
      }),
    );
    results.forEach((result, index) => {
      if (result.status !== 'rejected') return;
      const error: unknown = result.reason;
      logger.warn(
        {
          jobId: jobs[index].id,
          code:
            error instanceof MemoryError || error instanceof MemoryModelError
              ? error.code
              : 'MEMORY.UNEXPECTED',
        },
        '记忆后台任务执行失败，已保留持久状态。',
      );
    });
  };
  active = operation().finally(() => {
    active = undefined;
    controller = undefined;
  });
  return active;
}

export function startMemoryWorker(): void {
  if (timer) return;
  stopping = false;
  const tick = () => {
    void runMemoryWorkerOnce().catch(() => {
      logger.warn(
        { code: 'MEMORY.WORKER_FAILED' },
        '记忆后台任务暂不可用，将在下一轮重试。',
      );
    });
  };
  timer = setInterval(tick, POLL_MS);
  timer.unref();
  tick();
}

export async function stopMemoryWorker(): Promise<void> {
  stopping = true;
  if (timer) clearInterval(timer);
  timer = undefined;
  controller?.abort();
  if (!active) return;
  let stopTimer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      active,
      new Promise<void>((resolve) => {
        stopTimer = setTimeout(resolve, STOP_WAIT_MS);
      }),
    ]);
  } finally {
    if (stopTimer) clearTimeout(stopTimer);
  }
}
