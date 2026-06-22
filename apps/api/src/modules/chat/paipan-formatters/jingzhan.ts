import { formatGenericPaipan } from './fallback.js';
import type { PaipanFormatter } from './types.js';
import {
  arrayField,
  asRecord,
  formatQueryTime,
  pushSection,
  recordField,
  scalarArray,
  textField,
} from './utils.js';

const YAO_LABELS: Record<number, string> = {
  1: '初爻',
  2: '二爻',
  3: '三爻',
  4: '四爻',
  5: '五爻',
  6: '上爻',
};

/** 爻值（揲蓍数）到老少阴阳的换算：6 老阴、7 少阳、8 少阴、9 老阳。 */
const YAO_VALUE_LABELS: Record<number, string> = {
  6: '老阴',
  7: '少阳',
  8: '少阴',
  9: '老阳',
};

function movingPositions(gua: Record<string, unknown> | undefined): number[] {
  if (!gua) return [];
  return arrayField(gua, 'yaoList').flatMap((yao) => {
    const record = asRecord(yao);
    if (!record || record.isMoving !== true) return [];
    const position = Number(record.position);
    return Number.isFinite(position) ? [position] : [];
  });
}

function formatGuaSummary(label: string, value: unknown): string | undefined {
  const gua = asRecord(value);
  if (!gua) return undefined;
  const name = textField(gua, 'guaName');
  if (!name) return undefined;
  // 经占只取卦名，宫/五行/世应等卦宫纳甲信息不列。
  return `${label}：${name}`;
}

/** 列出指定爻位的爻辞；positions 为空（无动爻）则不列爻辞。 */
function formatMovingYaoCi(
  gua: Record<string, unknown>,
  positions: number[],
): string[] {
  const yaoCi = scalarArray(gua.yaoCi);
  return positions.flatMap((position) => {
    const text = yaoCi[position - 1];
    return text ? [`${YAO_LABELS[position] ?? `${position}爻`}：${text}`] : [];
  });
}

/** 经文取辞：列卦辞 + 指定爻位的爻辞（不列彖辞，经占以卦辞、动爻爻辞断）。 */
function formatScripture(
  label: string,
  value: unknown,
  positions: number[],
): string[] {
  const gua = asRecord(value);
  if (!gua) return [];
  const lines: string[] = [];
  const guaCi = textField(gua, 'guaCi');
  if (guaCi) lines.push(`${label}卦辞：${guaCi}`);
  for (const line of formatMovingYaoCi(gua, positions)) {
    lines.push(`${label}${line}`);
  }
  return lines;
}

/** 取卦的爻记录列表（过滤掉非对象项）。 */
function yaoRecords(
  gua: Record<string, unknown> | undefined,
): Record<string, unknown>[] {
  if (!gua) return [];
  return arrayField(gua, 'yaoList')
    .map(asRecord)
    .filter((yao): yao is Record<string, unknown> => Boolean(yao));
}

/**
 * 爻值摘要：逐爻列出本卦各爻的老少阴阳。
 *
 * 动爻（老阴/老阳）会变，附带其在变卦中变成的阴阳作为变爻；
 * 静爻（少阴/少阳）不变，不显示变爻。经占以卦爻辞断，不掺纳甲。
 */
function formatYaoValues(
  benGua: Record<string, unknown> | undefined,
  zhiGua: Record<string, unknown> | undefined,
): string[] {
  const zhiList = yaoRecords(zhiGua);
  return yaoRecords(benGua).map((yao) => {
    const position = Number(yao.position);
    const name = YAO_LABELS[position] ?? `${position}爻`;
    const label =
      YAO_VALUE_LABELS[Number(yao.yaoValue)] ?? textField(yao, 'yaoValue') ?? '';
    if (yao.isMoving !== true) {
      // 静爻不变，只列阴阳。
      return label ? `${name}：${label}` : name;
    }
    // 动爻附带变卦同爻位的阴阳（变爻）。
    const zhiYao = zhiList.find((item) => Number(item.position) === position);
    const zhiLabel = zhiYao
      ? YAO_VALUE_LABELS[Number(zhiYao.yaoValue)]
      : undefined;
    return zhiLabel
      ? `${name}：${label}（动，变${zhiLabel}）`
      : `${name}：${label}（动）`;
  });
}

/** 经占 formatter：按取辞、卦辞爻辞重排结果（经占以卦爻辞断，不含纳甲、神煞）。 */
export const formatJingzhanPaipan: PaipanFormatter = (artifactData) => {
  const root = asRecord(artifactData);
  if (!root || !recordField(root, 'benGua'))
    return formatGenericPaipan(artifactData);

  const benGua = recordField(root, 'benGua');
  const moves = movingPositions(benGua);
  const lines: string[] = [];

  pushSection(lines, '起卦概要', [
    textField(root, 'method')
      ? `起卦方式：${textField(root, 'method')}`
      : undefined,
    formatQueryTime(recordField(root, 'queryTime'))
      ? `起卦时间：${formatQueryTime(recordField(root, 'queryTime'))}`
      : undefined,
    textField(root, 'yaoString')
      ? `爻码：${textField(root, 'yaoString')}`
      : undefined,
    moves.length > 0
      ? `动爻：${moves.map((position) => YAO_LABELS[position] ?? `${position}爻`).join('、')}`
      : '动爻：无',
    textField(root, 'explanation')
      ? `取辞提示：${textField(root, 'explanation')}`
      : undefined,
  ]);

  pushSection(lines, '卦象关系', [
    formatGuaSummary('本卦', benGua),
    formatGuaSummary('变卦', recordField(root, 'zhiGua')),
    formatGuaSummary('互卦', recordField(root, 'huGua')),
  ]);
  pushSection(lines, '经文取辞', [
    ...formatScripture('本卦', benGua, moves),
    ...formatScripture('变卦', recordField(root, 'zhiGua'), moves),
    ...formatScripture('互卦', recordField(root, 'huGua'), []),
  ]);
  pushSection(
    lines,
    '爻值摘要',
    formatYaoValues(benGua, recordField(root, 'zhiGua')),
  );
  return lines.join('\n').trim();
};
