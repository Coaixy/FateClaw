/**
 * 可参与会员免费额度周期计算的会员时间字段。
 */
export interface MembershipCycleSource {
  /** 会员首次开通或本次重新开通的周期锚点。 */
  current_period_start?: string | null;
  /** 会员行创建时间，用于兼容历史提前续费把 current_period_start 推到未来的记录。 */
  created_at?: string | null;
}

export interface MembershipAllowancePeriod {
  /** 个人月度额度的固定锚点，通常等于开通时间。 */
  anchor: string;
  /** 当前额度周期开始时间。 */
  start: string;
  /** 当前额度周期结束时间，也是下次额度重置时间。 */
  end: string;
}

function parseValidDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addMonths(date: Date, months: number): Date {
  const next = new Date(date);
  const originalDate = next.getUTCDate();
  // 先落到月初再切月，避免月底日期被 JS Date 自动溢出到下下个月。
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + months);
  const lastDayOfTargetMonth = new Date(
    Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
  ).getUTCDate();
  next.setUTCDate(Math.min(originalDate, lastDayOfTargetMonth));
  return next;
}

function resolveMembershipCycleAnchor(
  source: MembershipCycleSource,
  reference: Date,
): Date {
  const periodStart = parseValidDate(source.current_period_start);
  const createdAt = parseValidDate(source.created_at);
  if (periodStart && periodStart.getTime() <= reference.getTime()) {
    return periodStart;
  }
  return createdAt ?? periodStart ?? reference;
}

/**
 * 计算会员当前个人月度额度周期。
 *
 * @param source 会员周期来源；优先使用 current_period_start 作为个人开通锚点，历史异常未来值会回退到 created_at。
 * @param reference 计算哪个时刻所在的额度周期，默认当前时间。
 * @returns 个人锚点、当前额度周期开始时间和下次额度重置时间。
 */
export function resolveMembershipAllowancePeriod(
  source: MembershipCycleSource,
  reference = new Date(),
): MembershipAllowancePeriod {
  const safeReference = Number.isNaN(reference.getTime())
    ? new Date()
    : reference;
  const anchor = resolveMembershipCycleAnchor(source, safeReference);
  let index = 0;
  let start = new Date(anchor);
  let end = addMonths(anchor, 1);

  while (end.getTime() <= safeReference.getTime()) {
    index += 1;
    start = addMonths(anchor, index);
    end = addMonths(anchor, index + 1);
  }

  return {
    anchor: anchor.toISOString(),
    start: start.toISOString(),
    end: end.toISOString(),
  };
}
