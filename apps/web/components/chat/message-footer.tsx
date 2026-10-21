'use client';

import type { ReactNode } from 'react';

const CURRENT_COMPACT_COST_RE = /^(积分实扣|積分實扣|Credits charged)\s+(.+)$/;

function compactCostLabel(label: string): string {
  const currentMatch = label.match(CURRENT_COMPACT_COST_RE);
  if (currentMatch) {
    const action = currentMatch[1];
    const amount = currentMatch[2];
    if (action === 'Credits charged') return `Charged ${amount}`;
    if (action === '積分實扣') return `實扣 ${amount}`;
    return `实扣 ${amount}`;
  }

  return label;
}

function MetricChip({
  children,
  ariaLabel,
}: {
  children: ReactNode;
  ariaLabel?: string;
}) {
  return (
    <span
      aria-label={ariaLabel}
      className="inline-flex min-h-5 w-full min-w-0 items-center justify-center whitespace-nowrap rounded-full border border-hairline bg-surface-card px-2 py-0.5 font-medium text-muted shadow-sm sm:w-auto"
    >
      {children}
    </span>
  );
}

/**
 * 渲染聊天消息下方的耗时与费用统计。
 *
 * @param props.isBot 当前消息是否为 AI 回复，用于决定左右对齐。
 * @param props.durationLabel 本轮回复耗时标签。
 * @param props.costLabels 本轮计费标签列表。
 * @returns 适配移动端换行的消息 footer；没有内容时返回 null。
 */
export function MessageFooter({
  isBot,
  durationLabel,
  costLabels,
}: {
  isBot: boolean;
  durationLabel?: string | null;
  costLabels?: string[];
}) {
  const hasMetrics = !!durationLabel || (costLabels?.length ?? 0) > 0;
  if (!hasMetrics) {
    return null;
  }

  const alignClass = isBot ? 'items-start text-left' : 'items-end text-right';
  const metricsAlignClass = isBot
    ? 'justify-items-start sm:justify-start'
    : 'justify-items-end sm:justify-end';

  return (
    <div
      className={`mt-1.5 flex max-w-full flex-col gap-1 px-1 text-[10px] tabular-nums ${alignClass}`}
    >
      <div
        className={`grid max-w-full grid-cols-2 gap-1.5 sm:flex sm:flex-wrap ${metricsAlignClass}`}
      >
        {durationLabel ? <MetricChip>{durationLabel}</MetricChip> : null}
        {costLabels?.map((costLabel) => (
          <MetricChip key={costLabel} ariaLabel={costLabel}>
            {compactCostLabel(costLabel)}
          </MetricChip>
        ))}
      </div>
    </div>
  );
}
