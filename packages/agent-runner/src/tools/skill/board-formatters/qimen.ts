import {
  asRecord,
  compactLines,
  getRecord,
  joinNonEmpty,
  labelValue,
  text,
} from './common.js';

const SKILL = 'qimen-paipan';
const LUOSHU_ORDER = ['巽', '离', '坤', '震', '中', '兑', '艮', '坎', '乾'] as const;

interface QimenPalaceMaps {
  tianPan: Record<string, unknown>;
  diPan: Record<string, unknown>;
  men: Record<string, unknown>;
  star: Record<string, unknown>;
  shen: Record<string, unknown>;
  anGan: Record<string, unknown>;
  changSheng?: Record<string, unknown>;
  menPo: Set<string>;
  jiXing: Set<string>;
}

function valuesOfRecord(record: Record<string, unknown> | undefined): string {
  if (!record) return '';
  return Object.values(record).map(text).filter(Boolean).join('/');
}

function changsheng(node: Record<string, unknown> | undefined): string {
  const map = getRecord(node ?? {}, '长生');
  return valuesOfRecord(map);
}

function palaceFlagSet(items: unknown, key: '宫' | '宫1' | '宫2'): Set<string> {
  if (!Array.isArray(items)) return new Set();
  return new Set(
    items
      .map((item) => asRecord(SKILL, item, `${key}[]`))
      .map((item) => text(item[key]).replace('宫', ''))
      .filter(Boolean),
  );
}

function buildPalaceMaps(root: Record<string, unknown>): QimenPalaceMaps {
  const jiXing = new Set([
    ...palaceFlagSet(root.击刑, '宫1'),
    ...palaceFlagSet(root.击刑, '宫2'),
  ]);
  return {
    tianPan: getRecord(root, '天盘') ?? {},
    diPan: getRecord(root, '地盘') ?? {},
    men: getRecord(root, '门') ?? {},
    star: getRecord(root, '星') ?? {},
    shen: getRecord(root, '神') ?? {},
    anGan: getRecord(root, '暗干') ?? {},
    changSheng: getRecord(root, '长生运'),
    menPo: palaceFlagSet(root.门迫, '宫'),
    jiXing,
  };
}

function palaceChangSheng(
  maps: QimenPalaceMaps,
  plate: '天盘' | '地盘',
  palace: string,
): string {
  const plateMap = getRecord(maps.changSheng ?? {}, plate);
  return changsheng(getRecord(plateMap ?? {}, palace));
}

function palaceWarnings(maps: QimenPalaceMaps, palace: string): string {
  return joinNonEmpty(
    [
      maps.menPo.has(palace) ? '迫' : '',
      maps.jiXing.has(palace) ? '刑' : '',
    ],
    '',
  );
}

function formatPlateItem(label: string, value: unknown, state = ''): string {
  const item = text(value);
  if (!item) return '';
  return `${label}${item}${state ? `(${state})` : ''}`;
}

function formatPalace(maps: QimenPalaceMaps, palace: string): string {
  const items = [
    formatPlateItem('神', maps.shen[palace]),
    formatPlateItem('星', maps.star[palace]),
    formatPlateItem(
      '天',
      maps.tianPan[palace],
      palaceChangSheng(maps, '天盘', palace),
    ),
    formatPlateItem('门', maps.men[palace], palaceWarnings(maps, palace)),
    formatPlateItem(
      '地',
      maps.diPan[palace],
      palaceChangSheng(maps, '地盘', palace),
    ),
    formatPlateItem('暗', maps.anGan[palace]),
  ];

  return `${palace}: ${joinNonEmpty(items, ' ')}`;
}

function formatArrayField(
  source: Record<string, unknown> | undefined,
  key: string,
  separator: string,
): string {
  const value = source?.[key];
  return Array.isArray(value) ? value.map(text).filter(Boolean).join(separator) : '';
}

function formatHeader(root: Record<string, unknown>): string | null {
  const header = joinNonEmpty(
    [
      text(root.排盘方式),
      text(root.干支),
      text(root.排局),
      text(root.节气),
    ],
    ' | ',
  );
  return header || null;
}

function formatCoreInfo(root: Record<string, unknown>): string[] {
  const zhifu = getRecord(root, '值符值使');
  const xunKong = getRecord(root, '旬空');
  const maXing = getRecord(root, '马星');
  return compactLines([
    labelValue('旬首: ', root.旬首),
    xunKong ? `旬空: 日${text(xunKong.日空)} 时${text(xunKong.时空)}` : null,
    labelValue('值符天干: ', formatArrayField(zhifu, '值符天干', '/')),
    labelValue('值符: ', formatArrayField(zhifu, '值符星宫', '')),
    labelValue('值使: ', formatArrayField(zhifu, '值使门宫', '')),
    labelValue('天乙: ', root.天乙),
    maXing ? `马星: ${formatMaXing(maXing)}` : null,
  ]);
}

function formatMaXing(maXing: Record<string, unknown>): string {
  return Object.entries(maXing)
    .map(([key, value]) => `${key}${text(value)}`)
    .filter(Boolean)
    .join('/');
}

function formatNinePalaces(root: Record<string, unknown>): string {
  const maps = buildPalaceMaps(root);
  return LUOSHU_ORDER.map((palace) => formatPalace(maps, palace)).join('\n');
}

export function formatQimenBoard(payload: unknown): string {
  const root = asRecord(SKILL, payload, 'payload');
  if (!getRecord(root, '天盘')) throw new Error(`[${SKILL}] 缺少 天盘 字段`);

  const lines = compactLines([
    '【奇门遁甲排盘 AI摘要】',
    '#基础',
    formatHeader(root),
    ...formatCoreInfo(root),
    '#九宫',
    formatNinePalaces(root),
  ]);

  return lines.join('\n');
}
