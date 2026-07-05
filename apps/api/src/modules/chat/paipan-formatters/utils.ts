/** 判断未知值是否为可按字段读取的普通对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 将未知值转换为普通对象；类型不匹配时返回 undefined。 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

/** 读取对象字段并要求该字段仍是普通对象。 */
export function recordField(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  return asRecord(record[key]);
}

/** 读取对象字段并要求该字段为数组。 */
export function arrayField(
  record: Record<string, unknown>,
  key: string,
): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

/** 将标量字段转换为可展示文本；空字符串、null 和 undefined 会被过滤。 */
export function scalarText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    const text = String(value).trim();
    return text || undefined;
  }
  return undefined;
}

/** 读取对象字段并按标量文本返回。 */
export function textField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  return scalarText(record[key]);
}

/** 拼接非空文本片段，避免 formatter 中反复写过滤逻辑。 */
export function joinText(
  values: Array<string | undefined>,
  separator = ' ',
): string {
  return values
    .filter((value): value is string => Boolean(value))
    .join(separator);
}

/** 用中文顿号拼接非空文本片段。 */
export function joinList(values: Array<string | undefined>): string {
  return joinText(values, '、');
}

/** 向输出追加一个中文小节；空小节会被跳过。 */
export function pushSection(
  lines: string[],
  title: string,
  body: Array<string | undefined>,
): void {
  const normalized = body.filter((line): line is string =>
    Boolean(line?.trim()),
  );
  if (normalized.length === 0) return;
  if (lines.length > 0) lines.push('');
  lines.push(`【${title}】`, ...normalized);
}

/** 将数组字段转换为标量文本列表。 */
export function scalarArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(scalarText).filter((item): item is string => Boolean(item));
}

/** 将 Record 中的标量值格式化为“key:value”列表。 */
export function recordScalarPairs(record: unknown): string[] {
  if (!isRecord(record)) return [];
  return Object.entries(record).flatMap(([key, value]) => {
    const text = scalarText(value);
    return text ? [`${key}:${text}`] : [];
  });
}

/** 使用中文时间习惯格式化 queryTime 一类结构化时间。 */
export function formatQueryTime(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const year = textField(record, 'year');
  const month = textField(record, 'month');
  const day = textField(record, 'day');
  const hour = textField(record, 'hour');
  const minute = textField(record, 'minute');
  if (!year || !month || !day) return undefined;
  return `${year}年${month}月${day}日${hour ?? '0'}时${minute ?? '0'}分`;
}
