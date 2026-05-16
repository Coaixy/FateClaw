/**
 * 当前环境：精确时间 + 年份 + 上下文预算状态（uncached）。
 */

import { formatLocalDateTime } from '../../utils/format-time.js';

export function buildEnvironmentSection(
  timezone: string,
  budgetInfo?: { estimatedTokens: number; contextWindow: number },
): string[] {
  const now = new Date();
  const localTime = formatLocalDateTime(now, timezone);

  const lines = [
    '## 当前环境',
    `现在是 ${now.getFullYear()} 年。当前时间: ${localTime} (${timezone})`,
  ];

  if (budgetInfo && budgetInfo.contextWindow > 0) {
    const usedK = Math.round(budgetInfo.estimatedTokens / 1000);
    const totalK = Math.round(budgetInfo.contextWindow / 1000);
    const ratio = budgetInfo.estimatedTokens / budgetInfo.contextWindow;

    if (ratio > 0.8) {
      lines.push(
        `[上下文状态] 已用约 ${usedK}k/${totalK}k tokens，请简洁回复。`,
      );
    } else if (ratio > 0.6) {
      lines.push(
        `[上下文状态] 已用约 ${usedK}k/${totalK}k tokens，注意控制回复长度。`,
      );
    }
    // ratio <= 0.6 时不提示，避免不必要的 token 消耗
  }

  return lines;
}
