export interface ModelPoolCooldown {
  seconds: number;
  reason: 'rate_limit' | 'quota';
}

/** Provider feedback owns supply limits; local counters do not predict remaining quota. */
export function modelPoolCooldown(
  status: number | undefined,
  message: string,
  retryAfter?: string,
  now = Date.now(),
): ModelPoolCooldown | undefined {
  const reportedStatus = status ?? Number(message.match(/\b(402|429)\b/)?.[1]);
  const quota =
    reportedStatus === 402 ||
    /insufficient[ _-]quota|quota.*(exceed|exhaust|reached)|daily|per.day|\brpd\b|\btpd\b|insufficient.*(balance|credit)|(?:balance|credit).*(?:insufficient|exhaust|low)|billing.*limit/i.test(
      message,
    );
  if (
    !quota &&
    reportedStatus !== 429 &&
    !/rate[ _-]?limit|too many requests|resource[ _-]exhausted/i.test(message)
  )
    return undefined;
  const numeric = retryAfter?.trim() ? Number(retryAfter) : NaN;
  const seconds = Number.isFinite(numeric)
    ? numeric
    : retryAfter
      ? (Date.parse(retryAfter) - now) / 1000
      : NaN;
  return {
    seconds: Number.isFinite(seconds)
      ? Math.min(86_400, Math.max(1, Math.ceil(seconds)))
      : quota
        ? 3_600
        : 60,
    reason: quota ? 'quota' : 'rate_limit',
  };
}
