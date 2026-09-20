const RECOVERY_POLL_INTERVAL_MS = 1_200;
const STREAM_RECONCILE_INTERVAL_MS = 15_000;
const STREAM_PROGRESS_GRACE_MS = 5_000;

/** A connected socket alone cannot prove that business events are arriving. */
export function shouldPollChatMessages(options: {
  now: number;
  lastPollAt: number | null;
  lastProgressAt: number | null;
  streamConnected: boolean;
}): boolean {
  if (options.lastPollAt === null) return true;
  const streamHealthy =
    options.streamConnected &&
    options.lastProgressAt !== null &&
    options.now - options.lastProgressAt < STREAM_PROGRESS_GRACE_MS;
  const interval = streamHealthy
    ? STREAM_RECONCILE_INTERVAL_MS
    : RECOVERY_POLL_INTERVAL_MS;
  return options.now - options.lastPollAt >= interval;
}
