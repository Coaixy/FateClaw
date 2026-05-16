import {
  asRecord,
  asRecordArray,
  compactLines,
  getArray,
  getRecord,
  joinNonEmpty,
  labelValue,
  text,
} from './common.js';

const SKILL = 'ziwei-paipan';
const HOROSCOPE_SCOPES = [
  'decadal',
  'age',
  'yearly',
  'monthly',
  'daily',
  'hourly',
] as const;

interface ParsedZiweiBoard {
  root: Record<string, unknown>;
  palaces: Array<Record<string, unknown>>;
}

function parseZiweiBoard(payload: unknown): ParsedZiweiBoard {
  const root = asRecord(SKILL, payload, 'payload');
  const palaces = asRecordArray(SKILL, getArray(root, 'palaces'), 'palaces');
  if (palaces.length === 0) throw new Error(`[${SKILL}] palaces 为空`);
  return { root, palaces };
}

function formatStar(star: Record<string, unknown>): string {
  return joinNonEmpty(
    [text(star.name), text(star.brightness), text(star.mutagen)],
    '',
  );
}

function formatStars(palace: Record<string, unknown>, key: string): string {
  return getArray(palace, key)
    .map((item) => asRecord(SKILL, item, `${key}[]`))
    .map(formatStar)
    .filter(Boolean)
    .join(',');
}

function formatStarsLine(
  label: string,
  palace: Record<string, unknown>,
  key: string,
): string | null {
  const stars = formatStars(palace, key);
  return stars ? `${label}:${stars}` : null;
}

function palaceFlags(palace: Record<string, unknown>): string {
  return joinNonEmpty([
    palace.isOriginalPalace === true ? '命' : '',
    palace.isBodyPalace === true ? '身' : '',
  ], '');
}

function decadalRange(palace: Record<string, unknown>): string {
  const decadal = getRecord(palace, 'decadal');
  return Array.isArray(decadal?.range)
    ? decadal.range.map(text).filter(Boolean).join('-')
    : '';
}

function formatPalace(palace: Record<string, unknown>): string {
  const flags = palaceFlags(palace);
  const range = decadalRange(palace);
  const palaceName = `${text(palace.earthlyBranch)}${text(palace.name)}`;
  const header = joinNonEmpty(
    [
      `${palaceName}${flags ? `[${flags}]` : ''}`,
      `${text(palace.heavenlyStem)}${text(palace.earthlyBranch)}`,
      range ? `${range}限` : '',
    ],
    ' ',
  );
  const starLines = compactLines([
    formatStarsLine('主星', palace, 'majorStars') ?? '主星:无',
    formatStarsLine('辅星', palace, 'minorStars'),
    formatStarsLine('杂曜', palace, 'adjectiveStars'),
  ]);
  return `${header}\n${starLines.map((line) => `  ${line}`).join('\n')}`;
}

function formatBirthInfo(root: Record<string, unknown>): string | null {
  const time = text(root.time)
    ? `${text(root.time)}${text(root.timeRange) ? `(${text(root.timeRange)})` : ''}`
    : '';
  const line = joinNonEmpty(
    [
      labelValue('阳历', root.solarDate),
      labelValue('农历', root.lunarDate),
      labelValue('四柱', root.chineseDate),
      time,
    ],
    ' | ',
  );
  return line || null;
}

function formatCoreInfo(root: Record<string, unknown>): string | null {
  const line = joinNonEmpty(
    [
      labelValue('命主', root.soul),
      labelValue('身主', root.body),
      labelValue('五行局', root.fiveElementsClass),
      labelValue('命宫地支', root.earthlyBranchOfSoulPalace),
      labelValue('身宫地支', root.earthlyBranchOfBodyPalace),
    ],
    '；',
  );
  return line || null;
}

function formatHoroscopeScope(scope: Record<string, unknown>): string {
  const mutagen = getArray(scope, 'mutagen').map(text).filter(Boolean).join('/');
  const palaceNames = getArray(scope, 'palaceNames').map(text).filter(Boolean).join('>');
  return joinNonEmpty(
    [
      text(scope.name),
      `${text(scope.heavenlyStem)}${text(scope.earthlyBranch)}`,
      mutagen ? `四化${mutagen}` : '',
      palaceNames ? `宫序${palaceNames}` : '',
    ],
    ' ',
  );
}

function formatHoroscope(root: Record<string, unknown>): string | null {
  const horoscope = getRecord(root, 'horoscope');
  if (!horoscope) return null;
  const scopes = HOROSCOPE_SCOPES
    .map((key) => getRecord(horoscope, key))
    .filter((scope): scope is Record<string, unknown> => Boolean(scope))
    .map(formatHoroscopeScope);
  if (scopes.length === 0) return null;

  const dateLabel = joinNonEmpty([
    text(horoscope.solarDate),
    text(horoscope.lunarDate),
  ], '/');
  return [`运盘(${dateLabel}):`, ...scopes.map((scope) => `  ${scope}`)].join('\n');
}

export function formatZiweiBoard(payload: unknown): string {
  const board = parseZiweiBoard(payload);
  const lines = compactLines([
    '【紫微斗数排盘 AI摘要】',
    '#基本信息',
    formatBirthInfo(board.root),
    formatCoreInfo(board.root),
    '#十二宫',
    ...board.palaces.map(formatPalace),
    formatHoroscope(board.root),
  ]);

  return lines.join('\n');
}
