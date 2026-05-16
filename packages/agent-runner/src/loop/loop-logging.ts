import { log } from '../io.js';
import type { TokenUsage } from '../types.js';

/** 将工具参数对象格式化为 key=value 形式，便于日志阅读。 */
export function formatArgs(args: Record<string, unknown>, maxLen = 60): string {
  return Object.entries(args)
    .map(([k, v]) => {
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return `${k}=${s.length > maxLen ? s.slice(0, maxLen) + '…' : s}`;
    })
    .join(' ');
}

/** 格式化字符数为可读标签（超过 1000 用 k 单位）。 */
export function sizeLabel(len: number): string {
  return len > 1000 ? `${(len / 1000).toFixed(1)}k字符` : `${len}字符`;
}

/** 输出循环结束汇总日志。 */
export function logLoopSummary(
  iterations: number,
  toolsUsed: string[],
  usage: TokenUsage,
): void {
  const chain = toolsUsed.length > 0 ? toolsUsed.join(' → ') : '无工具调用';
  log(
    `循环结束 | 共${iterations}轮 | 工具链: ${chain} | 总token: 输入=${usage.promptTokens} 输出=${usage.completionTokens}`,
  );
}
