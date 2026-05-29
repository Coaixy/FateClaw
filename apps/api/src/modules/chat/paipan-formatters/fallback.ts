import type { PaipanFormatter } from './types.js';
import { isRecord, scalarText } from './utils.js';

function formatNode(value: unknown, depth: number): string[] {
  const indent = '  '.repeat(depth);
  const scalar = scalarText(value);
  if (scalar) return [`${indent}${scalar}`];

  if (value === null) {
    return [`${indent}空`];
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}（空）`];
    if (
      value.every((item) => scalarText(item) !== undefined || item === null)
    ) {
      const line = value
        .map((item) => scalarText(item) ?? '空')
        .filter(Boolean)
        .join('、');
      return line ? [`${indent}${line}`] : [];
    }
    return value.flatMap((item, index) => {
      const itemLines = formatNode(item, depth + 1);
      return [`${indent}- 第 ${index + 1} 项：`, ...itemLines];
    });
  }

  if (!isRecord(value)) {
    return [];
  }

  const lines: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    const childScalar = scalarText(child);
    if (childScalar || child === null) {
      lines.push(`${indent}${key}：${childScalar ?? '空'}`);
      continue;
    }
    const childLines = formatNode(child, depth + 1);
    if (childLines.length === 0) continue;
    lines.push(`${indent}${key}：`, ...childLines);
  }
  return lines;
}

/** 通用兜底 formatter，用于未知术数或结构不符合专用 formatter 预期的结果。 */
export const formatGenericPaipan: PaipanFormatter = (artifactData) =>
  formatNode(artifactData, 0).join('\n').trim();
