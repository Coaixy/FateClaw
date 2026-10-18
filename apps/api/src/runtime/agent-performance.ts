export const AGENT_TIMING_STAGES = [
  'admission',
  'account_wait',
  'runtime_ready',
  'queue',
  'preparation',
  'first_content',
  'first_answer',
  'tool',
  'generation',
  'delivery',
] as const;
export type AgentTimingStage = (typeof AGENT_TIMING_STAGES)[number];

const SAMPLE_LIMIT = 256;
let cacheReadTokens = 0;
let cacheWriteTokens = 0;
const timings = new Map<
  AgentTimingStage,
  { count: number; totalMs: number; samples: number[] }
>();

export function recordAgentTiming(
  stage: AgentTimingStage,
  durationMs: number,
): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  const bucket = timings.get(stage) ?? { count: 0, totalMs: 0, samples: [] };
  bucket.count += 1;
  bucket.totalMs += durationMs;
  if (bucket.samples.length < SAMPLE_LIMIT) bucket.samples.push(durationMs);
  else bucket.samples[(bucket.count - 1) % SAMPLE_LIMIT] = durationMs;
  timings.set(stage, bucket);
}

export function recordAgentTraceTimings(events: unknown[] | undefined): void {
  for (const event of events ?? []) {
    if (!event || typeof event !== 'object') continue;
    const { type, stage, durationMs } = event as Record<string, unknown>;
    if (type === 'model_usage') {
      const usage = event as Record<string, unknown>;
      if (
        typeof usage.cacheReadTokens === 'number' &&
        Number.isFinite(usage.cacheReadTokens) &&
        usage.cacheReadTokens > 0
      )
        cacheReadTokens += usage.cacheReadTokens;
      if (
        typeof usage.cacheWriteTokens === 'number' &&
        Number.isFinite(usage.cacheWriteTokens) &&
        usage.cacheWriteTokens > 0
      )
        cacheWriteTokens += usage.cacheWriteTokens;
    }
    if (
      type === 'agent_timing' &&
      AGENT_TIMING_STAGES.includes(stage as AgentTimingStage) &&
      typeof durationMs === 'number'
    )
      recordAgentTiming(stage as AgentTimingStage, durationMs);
  }
}

export function getAgentPerformance() {
  return {
    cache: { cacheReadTokens, cacheWriteTokens },
    timings: Object.fromEntries(
      [...timings].map(([stage, bucket]) => {
        const sorted = [...bucket.samples].sort((a, b) => a - b);
        const percentile = (value: number) =>
          sorted[Math.max(0, Math.ceil(sorted.length * value) - 1)];
        return [
          stage,
          {
            count: bucket.count,
            meanMs: bucket.totalMs / bucket.count,
            p50Ms: percentile(0.5),
            p95Ms: percentile(0.95),
            sampleCount: sorted.length,
          },
        ];
      }),
    ),
  };
}
