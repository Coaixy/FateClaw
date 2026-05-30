/**
 * provider 返回的原始 Token 用量字段。
 *
 * @remarks 兼容不同 provider 对缓存 Token 的命名；调用方不要直接用这些原始字段扣费。
 */
export interface RuntimeTokenUsageInput {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * FateClaw 内部统一使用的 Token 用量字段。
 *
 * @remarks promptTokens 已合并缓存 Token，可直接用于展示、统计和扣费。
 */
export interface NormalizedRuntimeTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

function tokenNumber(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value < 0) return 0;
  return Math.trunc(value);
}

/**
 * 归一化模型返回的 Token 用量。
 *
 * 有些 provider 会把缓存命中/写入只放进 totalTokens，未合入 promptTokens。
 * FateClaw 只有输入/输出两档价格，因此 totalTokens 多出来的部分按输入 Token 记账，
 * 避免钱包明细和扣费低估缓存 Token。
 */
export function normalizeRuntimeTokenUsage(
  usage: RuntimeTokenUsageInput | null | undefined,
): NormalizedRuntimeTokenUsage {
  const promptTokens = tokenNumber(usage?.promptTokens);
  const completionTokens = tokenNumber(usage?.completionTokens);
  const declaredTotalTokens = tokenNumber(usage?.totalTokens);
  const splitTotalTokens = promptTokens + completionTokens;
  const explicitCacheTokens =
    tokenNumber(usage?.cacheRead) +
    tokenNumber(usage?.cacheWrite) +
    tokenNumber(usage?.cacheReadTokens) +
    tokenNumber(usage?.cacheWriteTokens);
  const extraInputTokens =
    declaredTotalTokens > 0
      ? Math.max(0, declaredTotalTokens - splitTotalTokens)
      : explicitCacheTokens;

  const normalizedPromptTokens = promptTokens + extraInputTokens;
  const normalizedSplitTotalTokens = normalizedPromptTokens + completionTokens;

  return {
    promptTokens: normalizedPromptTokens,
    completionTokens,
    totalTokens: Math.max(declaredTotalTokens, normalizedSplitTotalTokens),
  };
}
