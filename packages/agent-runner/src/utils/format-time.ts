/**
 * 时间格式化公共函数。
 *
 * 将散落在多处的 toLocaleString('zh-CN', ...) 逻辑集中到这里，
 * 所有时间相关的工具和 prompt 段共用。
 */

/**
 * 完整日期时间格式："2026年04月03日 星期四 14:30:00"
 * 用于 convert_time、environment prompt 等。
 */
export function formatLocalDateTime(date: Date, timezone: string): string {
  return date.toLocaleString('zh-CN', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/**
 * 短日期时间格式："04/03 14:30"
 * 用于 recall_history 等紧凑展示场景。
 */
export function formatLocalDateTimeShort(date: Date, timezone: string): string {
  return date.toLocaleString('zh-CN', {
    timeZone: timezone,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
