import { formatGenericPaipan } from './fallback.js';
import type { PaipanFormatter } from './types.js';
import {
  arrayField,
  asRecord,
  joinList,
  pushSection,
  recordField,
  recordScalarPairs,
  textField,
} from './utils.js';

const PALACE_ORDER = ['坎', '坤', '震', '巽', '中', '乾', '兑', '艮', '离'];

function palaceValue(
  root: Record<string, unknown>,
  field: string,
  palace: string,
): string | undefined {
  const record = recordField(root, field);
  return record ? textField(record, palace) : undefined;
}

function formatPalace(
  root: Record<string, unknown>,
  palace: string,
): string | undefined {
  const parts = joinList([
    palaceValue(root, '神', palace)
      ? `神 ${palaceValue(root, '神', palace)}`
      : undefined,
    palaceValue(root, '星', palace)
      ? `星 ${palaceValue(root, '星', palace)}`
      : undefined,
    palaceValue(root, '门', palace)
      ? `门 ${palaceValue(root, '门', palace)}`
      : undefined,
    palaceValue(root, '天盘', palace)
      ? `天盘 ${palaceValue(root, '天盘', palace)}`
      : undefined,
    palaceValue(root, '地盘', palace)
      ? `地盘 ${palaceValue(root, '地盘', palace)}`
      : undefined,
    palaceValue(root, '暗干', palace)
      ? `暗干 ${palaceValue(root, '暗干', palace)}`
      : undefined,
  ]);
  return parts ? `${palace}宫：${parts}` : undefined;
}

function formatMenpo(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const door = textField(record, '门');
  const palace = textField(record, '宫');
  if (!door || !palace) return undefined;
  return `${palace}宫:${door}门迫`;
}

function formatJixing(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const palace = textField(record, '宫2') || textField(record, '落宫');
  const instrument =
    textField(record, '六仪') || textField(record, '宫1')?.slice(-1);
  if (!palace || !instrument) return undefined;
  return `${palace}宫：${instrument}`;
}

function formatChangshengPan(value: unknown): string[] {
  const pan = asRecord(value);
  if (!pan) return [];
  return Object.entries(pan).flatMap(([panName, item]) => {
    const panRecord = asRecord(item);
    const changsheng = panRecord ? recordField(panRecord, '长生') : undefined;
    if (!changsheng) return [];
    const pairs = recordScalarPairs(changsheng);
    if (pairs.length === 0) return [];
    return [`${panName}：${pairs.join('、')}`];
  });
}

/** 奇门 formatter：按局盘概要、九宫和断局辅助项重排结果。 */
export const formatQimenPaipan: PaipanFormatter = (artifactData) => {
  const root = asRecord(artifactData);
  if (!root || !recordField(root, '值符值使'))
    return formatGenericPaipan(artifactData);

  const lines: string[] = [];

  pushSection(lines, '局盘概要', [
    textField(root, '排盘方式')
      ? `排盘方式：${textField(root, '排盘方式')}`
      : undefined,
    textField(root, '干支') ? `四柱：${textField(root, '干支')}` : undefined,
    textField(root, '局日') ? `局日：${textField(root, '局日')}` : undefined,
    textField(root, '排局') ? `排局：${textField(root, '排局')}` : undefined,
    textField(root, '节气') ? `节气：${textField(root, '节气')}` : undefined,
    textField(root, '旬首') ? `旬首：${textField(root, '旬首')}` : undefined,
    recordScalarPairs(recordField(root, '旬空')).length > 0
      ? `旬空：${recordScalarPairs(recordField(root, '旬空')).join('、')}`
      : undefined,
    recordScalarPairs(recordField(root, '马星')).length > 0
      ? `马星：${recordScalarPairs(recordField(root, '马星')).join('、')}`
      : undefined,
  ]);

  pushSection(
    lines,
    '九宫盘',
    PALACE_ORDER.map((palace) => formatPalace(root, palace)),
  );
  pushSection(lines, '门迫', arrayField(root, '门迫').map(formatMenpo));
  pushSection(lines, '击刑', arrayField(root, '击刑').map(formatJixing));
  pushSection(
    lines,
    '长生运',
    formatChangshengPan(recordField(root, '长生运')),
  );

  return lines.join('\n').trim();
};
