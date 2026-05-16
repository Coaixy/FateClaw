export class BoardFormatError extends Error {
  constructor(
    public readonly skill: string,
    message: string,
  ) {
    super(`[${skill}] ${message}`);
  }
}

export function parseBoardPayload(args: {
  skill: string;
  output: string;
  artifactData?: unknown;
}): unknown {
  if (args.artifactData !== undefined) return args.artifactData;
  try {
    return JSON.parse(args.output) as unknown;
  } catch {
    throw new BoardFormatError(args.skill, '排盘输出不是有效 JSON，无法生成 AI 摘要');
  }
}

export function asRecord(
  skill: string,
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BoardFormatError(skill, `${label} 不是对象`);
  }
  return value as Record<string, unknown>;
}

export function asRecordArray(
  skill: string,
  value: unknown,
  label: string,
): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    throw new BoardFormatError(skill, `${label} 不是数组`);
  }
  return value.map((item, index) => asRecord(skill, item, `${label}[${index}]`));
}

export function getRecord(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const next = value[key];
  return next && typeof next === 'object' && !Array.isArray(next)
    ? (next as Record<string, unknown>)
    : undefined;
}

export function getArray(value: Record<string, unknown>, key: string): unknown[] {
  const next = value[key];
  return Array.isArray(next) ? next : [];
}

export function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

export function joinNonEmpty(
  parts: Array<string | undefined | null | false>,
  separator: string,
): string {
  return parts
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(separator);
}

export function compactLine(label: string, value: string): string | null {
  return value.trim() ? `${label}: ${value}` : null;
}

export function compactLines(
  lines: Array<string | null | undefined | false>,
): string[] {
  return lines.filter((line): line is string => Boolean(line && line.trim()));
}

export function labelValue(label: string, value: unknown): string {
  const normalized = text(value);
  return normalized ? `${label}${normalized}` : '';
}

export function stringifyPayloadForError(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}
