import { resolveContextWindow } from './model-context-window.js';

// 未显式配置时按上下文窗口自动预留输出空间，避免所有协议都被固定卡在同一个小值。
const AUTO_OUTPUT_CONTEXT_RATIO = 0.08;
const MIN_AUTO_OUTPUT_TOKENS = 4_096;
const MAX_AUTO_OUTPUT_TOKENS = 32_768;

function clampAutoOutputTokens(tokens: number): number {
  return Math.min(
    MAX_AUTO_OUTPUT_TOKENS,
    Math.max(MIN_AUTO_OUTPUT_TOKENS, tokens),
  );
}

export function getDefaultMaxOutputTokens(
  model: string,
  contextWindowTokens?: number | null,
): number {
  return clampAutoOutputTokens(
    Math.floor(
      resolveContextWindow({
        model,
        configured: contextWindowTokens,
      }) * AUTO_OUTPUT_CONTEXT_RATIO,
    ),
  );
}
