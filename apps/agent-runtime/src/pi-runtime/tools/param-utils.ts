/**
 * Pi 工具入参规范化公共函数。
 *
 * 8 个 Pi 工具的 readInteger/readBoolean/readString/limit 归一化此前各写一遍，
 * 抽出后消除「改一处要改八处」的维护成本。
 *
 * 注意：soul 工具的 readString 语义不同（返回 '' 且不 trim，以完整保全 newContent），
 * 不并入此处，仍保留在 soul-tool.ts 本地。
 */

/** 读取并 trim 字符串参数；空串或非字符串返回 undefined。 */
export function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** 读取整数参数；非有限数返回 undefined，否则向零截断。 */
export function readInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.trunc(value);
}

/** 读取布尔参数；兼容模型把布尔传成字符串 'true'/'false' 的情况。 */
export function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

/**
 * 归一化 limit 参数。
 *
 * 参数：
 * - value：模型传入的原始值。
 * - fallback：缺失或非正时回退的默认值。
 * - max：上限，超过则夹紧。
 *
 * 返回：落在 (0, max] 区间内的整数。
 */
export function clampLimit(value: unknown, fallback: number, max: number): number {
  const limit = readInteger(value) ?? fallback;
  if (limit <= 0) return fallback;
  return Math.min(limit, max);
}

/** 把工具的结构化结果统一序列化为给模型阅读的缩进 JSON 文本。 */
export function toJsonOutput(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
