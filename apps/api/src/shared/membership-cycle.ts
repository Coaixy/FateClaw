/** Dates needed to retain the membership start when renewing. */
export interface MembershipCycleSource {
  current_period_start?: string | null;
  created_at?: string | null;
}

function parseValidDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function resolveMembershipPeriodStart(
  source: MembershipCycleSource,
  reference = new Date(),
): Date {
  const safeReference = Number.isNaN(reference.getTime())
    ? new Date()
    : reference;
  const periodStart = parseValidDate(source.current_period_start);
  if (periodStart && periodStart.getTime() <= safeReference.getTime()) {
    return periodStart;
  }
  // A future period start cannot anchor the current renewal; retain its creation date.
  return parseValidDate(source.created_at) ?? periodStart ?? safeReference;
}
