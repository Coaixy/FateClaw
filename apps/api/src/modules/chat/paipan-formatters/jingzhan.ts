import { formatGenericPaipan } from './fallback.js';
import type { PaipanFormatter } from './types.js';
import {
  arrayField,
  asRecord,
  formatQueryTime,
  joinList,
  pushSection,
  recordField,
  scalarArray,
  scalarText,
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
  const detail = joinList([
    textField(gua, 'palace') ? `${textField(gua, 'palace')}宫` : undefined,
    textField(gua, 'palaceWuXing')
      ? `五行${textField(gua, 'palaceWuXing')}`
      : undefined,
    textField(gua, 'palaceLevel'),
    textField(gua, 'wuXingStar')
      ? `五星${textField(gua, 'wuXingStar')}`
      : undefined,
    textField(gua, 'shenYao') ? `身爻${textField(gua, 'shenYao')}` : undefined,
  ]);
  return detail ? `${label}：${name}（${detail}）` : `${label}：${name}`;
}

function formatMovingYaoCi(
  gua: Record<string, unknown>,
  positions: number[],
): string[] {
  const yaoCi = scalarArray(gua.yaoCi);
  if (positions.length === 0) {
    return yaoCi.map(
      (text, index) => `${YAO_LABELS[index + 1] ?? `${index + 1}爻`}：${text}`,
    );
  }
  return positions.flatMap((position) => {
    const text = yaoCi[position - 1];
    return text ? [`${YAO_LABELS[position] ?? `${position}爻`}：${text}`] : [];
  });
}

function formatScripture(
  label: string,
  value: unknown,
  positions: number[],
): string[] {
  const gua = asRecord(value);
  if (!gua) return [];
  const lines = [
    textField(gua, 'guaCi')
      ? `${label}卦辞：${textField(gua, 'guaCi')}`
      : undefined,
    textField(gua, 'tuanCi')
      ? `${label}彖辞：${textField(gua, 'tuanCi')}`
      : undefined,
  ].filter((line): line is string => Boolean(line));
  for (const line of formatMovingYaoCi(gua, positions)) {
    lines.push(`${label}${line}`);
  }
  return lines;
}

function formatYaoValues(label: string, value: unknown): string | undefined {
  const gua = asRecord(value);
  if (!gua) return undefined;
  const values = arrayField(gua, 'yaoList')
    .map(asRecord)
    .filter((yao): yao is Record<string, unknown> => Boolean(yao))
    .map((yao) => {
      const position = Number(yao.position);
      const name = YAO_LABELS[position] ?? `${position}爻`;
      return joinList([
        name,
        textField(yao, 'yaoValue')
          ? `爻值${textField(yao, 'yaoValue')}`
          : undefined,
        yao.isMoving === true ? '动' : '静',
        textField(yao, 'naYin') ? `纳音${textField(yao, 'naYin')}` : undefined,
      ]);
    });
  return values.length > 0 ? `${label}：${values.join('；')}` : undefined;
}

function formatShenSha(value: unknown): string | undefined {
  const values = scalarArray(value);
  if (values.length > 0) return values.join('、');
  return scalarText(value);
}

/** 经占 formatter：按取辞、卦辞爻辞和神煞落点重排结果。 */
export const formatJingzhanPaipan: PaipanFormatter = (artifactData) => {
  const root = asRecord(artifactData);
  if (!root || !recordField(root, 'benGua'))
    return formatGenericPaipan(artifactData);

  const benGua = recordField(root, 'benGua');
  const moves = movingPositions(benGua);
  const lines: string[] = [];

  pushSection(lines, '起卦概要', [
    textField(root, 'question')
      ? `问题：${textField(root, 'question')}`
      : undefined,
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
    ...formatScripture('变卦', recordField(root, 'zhiGua'), []),
    ...formatScripture('互卦', recordField(root, 'huGua'), []),
  ]);
  pushSection(lines, '爻值摘要', [
    formatYaoValues('本卦', benGua),
    formatYaoValues('变卦', recordField(root, 'zhiGua')),
    formatYaoValues('互卦', recordField(root, 'huGua')),
  ]);
  pushSection(
    lines,
    '神煞',
    Object.entries(recordField(root, 'shenSha') ?? {}).flatMap(
      ([name, value]) => {
        const text = formatShenSha(value);
        return text ? [`${name}：${text}`] : [];
      },
    ),
  );

  return lines.join('\n').trim();
};
