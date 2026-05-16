import type { TokenUsage } from '../types.js';
import { getContextWindowForModel } from '../model-context-window.js';
export { getContextWindowForModel } from '../model-context-window.js';

/**
 * 估算文本 token 数，区分 CJK 和 ASCII 字符。
 * CJK 约 1.2 字符/token，ASCII 约 3.2 字符/token（含 JSON 结构开销），结果偏保守。
 */
export function roughTokenCount(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk / 1.2 + other / 3.2);
}

export function accumulateUsage(
  target: TokenUsage,
  next:
    | {
        promptTokens: number;
        completionTokens: number;
        totalTokens?: number;
      }
    | null
    | undefined,
): void {
  if (!next) return;
  target.promptTokens += next.promptTokens;
  target.completionTokens += next.completionTokens;
  target.totalTokens +=
    next.totalTokens ?? next.promptTokens + next.completionTokens;
}

/** 校准状态：用 API 返回的真实 token 数反馈校准粗估系数。 */
export interface TokenCalibration {
  /**
   * 校准系数：actualTokens / estimatedTokens。
   * 初始值 1.2 — 考虑到 system prompt 不计入 messages 估算、
   * JSON 序列化开销等系统性低估因素，1.2 比 1.0 收敛更快。
   */
  factor: number;
}

/**
 * 用 API 返回的真实 promptTokens 更新校准系数。
 * 始终使用 EMA（指数移动平均）平滑更新，避免首次异常值造成剧烈波动。
 */
export function updateCalibration(
  calibration: TokenCalibration,
  estimated: number,
  actual: number,
): void {
  if (estimated <= 0 || actual <= 0) return;
  const observed = actual / estimated;
  calibration.factor = calibration.factor * 0.7 + observed * 0.3;
  calibration.factor = Math.max(0.5, Math.min(2.0, calibration.factor));
}

/** 用 roughTokenCount 粗估整个 messages 数组的 prompt token 数。 */
export function estimateMessagesTokensRough<TMsg>(messages: TMsg[]): number {
  return roughTokenCount(JSON.stringify(messages));
}
