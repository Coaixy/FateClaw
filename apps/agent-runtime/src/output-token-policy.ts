import { getContextWindowForModel } from './model-context-window.js';

// 与 API 侧保持同一套自动策略：未配置时按模型上下文窗口预留输出空间。
const AUTO_OUTPUT_CONTEXT_RATIO = 0.08;
const MIN_AUTO_OUTPUT_TOKENS = 4_096;
const MAX_AUTO_OUTPUT_TOKENS = 32_768;

function clampAutoOutputTokens(tokens: number): number {
  return Math.min(
    MAX_AUTO_OUTPUT_TOKENS,
    Math.max(MIN_AUTO_OUTPUT_TOKENS, tokens),
  );
}

export function getDefaultMaxOutputTokens(model: string): number {
  return clampAutoOutputTokens(
    Math.floor(getContextWindowForModel(model) * AUTO_OUTPUT_CONTEXT_RATIO),
  );
}

export function resolveCompletionMaxOutputTokens(args: {
  model: string;
  configured?: number;
}): number {
  return args.configured ?? getDefaultMaxOutputTokens(args.model);
}
