const OFFICIAL_PAIPAN_TITLES: Record<string, string> = {
  'bazi-paipan': '八字排盘',
  'iching-paipan': '六爻排盘',
  'jingzhan-paipan': '经占排盘',
  'qimen-paipan': '奇门遁甲排盘',
  'ziwei-paipan': '紫微斗数排盘',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function formatScalar(value: unknown): string {
  if (value === null) return '空';
  if (value === undefined) return '';
  return String(value);
}

function formatNode(value: unknown, depth: number): string[] {
  const indent = '  '.repeat(depth);

  if (isScalar(value)) {
    const scalar = formatScalar(value);
    return scalar ? [`${indent}${scalar}`] : [];
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}（空）`];
    if (value.every(isScalar)) {
      const line = value.map(formatScalar).filter(Boolean).join('、');
      return line ? [`${indent}${line}`] : [];
    }
    return value.flatMap((item, index) => {
      const itemLines = formatNode(item, depth + 1);
      return [`${indent}- 第 ${index + 1} 项：`, ...itemLines];
    });
  }

  if (!isRecord(value)) {
    const text = formatScalar(value);
    return text ? [`${indent}${text}`] : [];
  }

  const lines: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    if (isScalar(child)) {
      lines.push(`${indent}${key}：${formatScalar(child)}`);
      continue;
    }
    const childLines = formatNode(child, depth + 1);
    if (childLines.length === 0) continue;
    lines.push(`${indent}${key}：`, ...childLines);
  }
  return lines;
}

export function formatOfficialPaipan(
  skill: string,
  artifactData: unknown,
): string {
  if (artifactData === undefined) return '';
  const title = OFFICIAL_PAIPAN_TITLES[skill] ?? skill;
  const body = formatNode(artifactData, 0);
  return [`${title}（系统排盘结果）`, ...body].join('\n').trim();
}
