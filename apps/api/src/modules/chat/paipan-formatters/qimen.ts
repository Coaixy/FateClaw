import { fullQimenGodName } from '@fateclaw/contracts/chat';

import { formatGenericPaipan } from './fallback.js';
import type { PaipanFormatter } from './types.js';
import {
  arrayField,
  asRecord,
  joinList,
  pushSection,
  recordField,
  recordScalarPairs,
  scalarArray,
  textField,
} from './utils.js';

const PALACE_ORDER = ['坎', '坤', '震', '巽', '乾', '兑', '艮', '离'];

function palaceValue(
  root: Record<string, unknown>,
  field: string,
  palace: string,
): string | undefined {
  const record = recordField(root, field);
  return record ? textField(record, palace) : undefined;
}

function joinGan(
  jiGan: string | undefined,
  gan: string | undefined,
): string | undefined {
  if (!jiGan) return gan;
  if (!gan || jiGan === gan) return gan ?? jiGan;
  return `${jiGan}${gan}`;
}

function skyJiGan(
  root: Record<string, unknown>,
  palace: string,
): string | undefined {
  if (root.盘式 === '鸣法') return undefined;
  const explicit =
    palaceValue(root, '天盘寄干', palace) ?? palaceValue(root, '寄干', palace);
  if (explicit) return explicit;
  const centerGan = palaceValue(root, '天盘', '中');
  const star = palaceValue(root, '星', palace);
  return centerGan && star?.includes('禽') ? centerGan : undefined;
}

function earthJiGan(
  root: Record<string, unknown>,
  palace: string,
): string | undefined {
  if (root.盘式 === '鸣法') return undefined;
  const explicit =
    palaceValue(root, '地盘寄干', palace) ??
    palaceValue(root, '寄宫干', palace);
  if (explicit) return explicit;
  return palace === '坤'
    ? (palaceValue(root, '地盘', '中') ?? palaceValue(root, '天盘', '中'))
    : undefined;
}

function formatPalace(
  root: Record<string, unknown>,
  palace: string,
): string | undefined {
  const skyGan = palaceValue(root, '天盘', palace);
  const earthGan = palaceValue(root, '地盘', palace);
  const parts = joinList([
    palaceValue(root, '神', palace)
      ? `神 ${fullQimenGodName(palaceValue(root, '神', palace)!)}`
      : undefined,
    palaceValue(root, '星', palace)
      ? `星 ${palaceValue(root, '星', palace)}`
      : undefined,
    palaceValue(root, '门', palace)
      ? `门 ${palaceValue(root, '门', palace)}`
      : undefined,
    joinGan(skyJiGan(root, palace), skyGan)
      ? `天盘 ${joinGan(skyJiGan(root, palace), skyGan)}`
      : undefined,
    joinGan(earthJiGan(root, palace), earthGan)
      ? `地盘 ${joinGan(earthJiGan(root, palace), earthGan)}`
      : undefined,
    palaceValue(root, '暗干', palace)
      ? `暗干 ${palaceValue(root, '暗干', palace)}`
      : undefined,
    palaceValue(root, '暗支', palace)
      ? `暗支 ${palaceValue(root, '暗支', palace)}`
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
  const elements = recordScalarPairs({
    门五行: textField(record, '门五行'),
    宫五行: textField(record, '宫五行'),
  });
  return `${palace}宫：${door}门迫${elements.length ? `（${elements.join('、')}）` : ''}`;
}

function formatJixing(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const palace = textField(record, '宫2') || textField(record, '落宫');
  const instrument =
    textField(record, '六仪') || textField(record, '宫1')?.slice(-1);
  if (!palace || !instrument) return undefined;
  const gan = textField(record, '宫1') || instrument;
  return `${palace}宫：${gan}${textField(record, '类型') || '击刑'}（六仪:${instrument}）`;
}

function formatChangshengPan(value: unknown): string[] {
  const pan = asRecord(value);
  if (!pan) return [];
  return [...PALACE_ORDER, '中'].flatMap((palace) => {
    const panRecord = asRecord(pan[palace]);
    const changsheng = panRecord ? recordField(panRecord, '长生') : undefined;
    if (!changsheng) return [];
    const pairs = recordScalarPairs(changsheng);
    if (pairs.length === 0) return [];
    const gan = panRecord ? textField(panRecord, '天干') : undefined;
    return [`${palace}宫${gan ? `（${gan}）` : ''}：${pairs.join('、')}`];
  });
}

function formatStarPalace(value: unknown): string | undefined {
  const [star, palace] = scalarArray(value);
  if (!star) return undefined;
  const name =
    star === '芮禽' ? '天芮、天禽' : star.startsWith('天') ? star : `天${star}`;
  return `${name}${palace ? `（${palace}宫）` : ''}`;
}

function formatDoorPalace(value: unknown): string | undefined {
  const [door, palace] = scalarArray(value);
  if (!door) return undefined;
  return `${door}门${palace ? `（${palace}宫）` : ''}`;
}

/** Export every Qimen chart fact for both clipboard text and model input. */
export const formatQimenPaipan: PaipanFormatter = (artifactData) => {
  const root = asRecord(artifactData);
  if (!root || !recordField(root, '值符值使'))
    return formatGenericPaipan(artifactData);

  const lines: string[] = [];
  const leadership = recordField(root, '值符值使')!;
  const leaderGan = scalarArray(leadership.值符天干).join('、');
  const leaderStar = formatStarPalace(leadership.值符星宫);
  const leaderDoor = formatDoorPalace(leadership.值使门宫);

  pushSection(lines, '局盘概要', [
    textField(root, '盘式') ? `盘式：${textField(root, '盘式')}` : undefined,
    textField(root, '排盘方式')
      ? `排盘方式：${textField(root, '排盘方式')}`
      : undefined,
    textField(root, '干支') ? `四柱：${textField(root, '干支')}` : undefined,
    textField(root, '局日') ? `局日：${textField(root, '局日')}` : undefined,
    textField(root, '排局') ? `排局：${textField(root, '排局')}` : undefined,
    textField(root, '节气') ? `节气：${textField(root, '节气')}` : undefined,
    textField(root, '旬首') ? `旬首：${textField(root, '旬首')}` : undefined,
    leaderGan ? `值符天干：${leaderGan}` : undefined,
    leaderStar ? `值符星宫：${leaderStar}` : undefined,
    leaderDoor ? `值使门宫：${leaderDoor}` : undefined,
    textField(root, '天乙') ? `天乙：${textField(root, '天乙')}` : undefined,
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
    (root.盘式 === '鸣法' ? [...PALACE_ORDER, '中'] : PALACE_ORDER).map(
      (palace) => formatPalace(root, palace),
    ),
  );
  if (root.盘式 !== '鸣法') {
    pushSection(lines, '中宫原始数据', [formatPalace(root, '中')]);
  }
  const menpo = arrayField(root, '门迫').map(formatMenpo).filter(Boolean);
  const jixing = arrayField(root, '击刑').map(formatJixing).filter(Boolean);
  pushSection(
    lines,
    '门迫',
    Array.isArray(root.门迫) && root.门迫.length === 0 ? ['无'] : menpo,
  );
  pushSection(
    lines,
    '击刑',
    Array.isArray(root.击刑) && root.击刑.length === 0 ? ['无'] : jixing,
  );
  const growth = recordField(root, '长生运');
  pushSection(lines, '长生运·天盘', formatChangshengPan(growth?.天盘));
  pushSection(lines, '长生运·地盘', formatChangshengPan(growth?.地盘));

  return lines.join('\n').trim();
};
