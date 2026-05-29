import { formatGenericPaipan } from './fallback.js';
import type { PaipanFormatter } from './types.js';
import {
  arrayField,
  asRecord,
  joinList,
  joinText,
  pushSection,
  recordField,
  scalarArray,
  textField,
} from './utils.js';

function formatStar(value: unknown): string | undefined {
  const star = asRecord(value);
  if (!star) return undefined;
  const name = textField(star, 'name');
  if (!name) return undefined;
  const detail = joinList([
    textField(star, 'brightness'),
    textField(star, 'mutagen') ? `化${textField(star, 'mutagen')}` : undefined,
  ]);
  return detail ? `${name}（${detail}）` : name;
}

function formatStars(
  palace: Record<string, unknown>,
  field: string,
): string | undefined {
  const stars = arrayField(palace, field)
    .map(formatStar)
    .filter((star): star is string => Boolean(star));
  return stars.length > 0 ? stars.join('、') : undefined;
}

function formatDecadal(value: unknown): string | undefined {
  const decadal = asRecord(value);
  if (!decadal) return undefined;
  const range = Array.isArray(decadal.range) ? decadal.range.map(String) : [];
  const ageRange = range.length >= 2 ? `${range[0]}-${range[1]}岁` : undefined;
  const stemBranch = joinText(
    [textField(decadal, 'heavenlyStem'), textField(decadal, 'earthlyBranch')],
    '',
  );
  return joinList([ageRange, stemBranch ? `干支 ${stemBranch}` : undefined]);
}

function formatPalace(value: unknown): string | undefined {
  const palace = asRecord(value);
  if (!palace) return undefined;
  const name = textField(palace, 'name');
  const branch = joinText(
    [textField(palace, 'heavenlyStem'), textField(palace, 'earthlyBranch')],
    '',
  );
  if (!name && !branch) return undefined;
  const markers = joinList([
    palace.isBodyPalace === true ? '身宫' : undefined,
    palace.isOriginalPalace === true ? '来因宫' : undefined,
  ]);
  const title = `${name ?? '未命名宫'}${branch ? `（${branch}）` : ''}`;
  const details = joinList([
    markers || undefined,
    formatStars(palace, 'majorStars')
      ? `主星 ${formatStars(palace, 'majorStars')}`
      : undefined,
    formatStars(palace, 'minorStars')
      ? `辅星 ${formatStars(palace, 'minorStars')}`
      : undefined,
    formatDecadal(recordField(palace, 'decadal'))
      ? `大限 ${formatDecadal(recordField(palace, 'decadal'))}`
      : undefined,
  ]);
  return details ? `${title}：${details}` : title;
}

function formatHoroscopeItem(value: unknown): string | undefined {
  const item = asRecord(value);
  if (!item) return undefined;
  const name = textField(item, 'name') ?? '运限';
  const stemBranch = joinText(
    [textField(item, 'heavenlyStem'), textField(item, 'earthlyBranch')],
    '',
  );
  const mutagen = scalarArray(item.mutagen);
  const palaceNames = scalarArray(item.palaceNames);
  const details = joinList([
    stemBranch || undefined,
    textField(item, 'nominalAge')
      ? `${textField(item, 'nominalAge')}岁`
      : undefined,
    mutagen.length > 0 ? `四化 ${mutagen.join('、')}` : undefined,
    palaceNames.length > 0 ? `流宫顺序 ${palaceNames.join(' -> ')}` : undefined,
  ]);
  return details ? `${name}：${details}` : name;
}

function formatHoroscope(value: unknown): string[] {
  const horoscope = asRecord(value);
  if (!horoscope) return [];
  const lines: string[] = [
    textField(horoscope, 'solarDate')
      ? `运盘公历：${textField(horoscope, 'solarDate')}`
      : undefined,
    textField(horoscope, 'lunarDate')
      ? `运盘农历：${textField(horoscope, 'lunarDate')}`
      : undefined,
  ].filter((line): line is string => Boolean(line));
  for (const key of [
    'decadal',
    'age',
    'yearly',
    'monthly',
    'daily',
    'hourly',
  ]) {
    const line = formatHoroscopeItem(recordField(horoscope, key));
    if (line) lines.push(line);
  }
  return lines;
}

/** 紫微 formatter：按命盘概要、十二宫和叠加运盘重排结果。 */
export const formatZiweiPaipan: PaipanFormatter = (artifactData) => {
  const root = asRecord(artifactData);
  if (!root || !Array.isArray(root.palaces))
    return formatGenericPaipan(artifactData);

  const lines: string[] = [];

  pushSection(lines, '命盘概要', [
    textField(root, 'solarDate')
      ? `公历：${textField(root, 'solarDate')}`
      : undefined,
    textField(root, 'lunarDate')
      ? `农历：${textField(root, 'lunarDate')}`
      : undefined,
    textField(root, 'chineseDate')
      ? `四柱：${textField(root, 'chineseDate')}`
      : undefined,
    textField(root, 'time') || textField(root, 'timeRange')
      ? `时辰：${joinText([textField(root, 'time'), textField(root, 'timeRange')])}`
      : undefined,
    textField(root, 'sign') ? `星座：${textField(root, 'sign')}` : undefined,
    textField(root, 'zodiac')
      ? `生肖：${textField(root, 'zodiac')}`
      : undefined,
    textField(root, 'soul') ? `命主：${textField(root, 'soul')}` : undefined,
    textField(root, 'body') ? `身主：${textField(root, 'body')}` : undefined,
    textField(root, 'fiveElementsClass')
      ? `五行局：${textField(root, 'fiveElementsClass')}`
      : undefined,
    textField(root, 'earthlyBranchOfSoulPalace')
      ? `命宫地支：${textField(root, 'earthlyBranchOfSoulPalace')}`
      : undefined,
    textField(root, 'earthlyBranchOfBodyPalace')
      ? `身宫地支：${textField(root, 'earthlyBranchOfBodyPalace')}`
      : undefined,
  ]);

  pushSection(lines, '十二宫', arrayField(root, 'palaces').map(formatPalace));
  pushSection(
    lines,
    '运盘叠加',
    formatHoroscope(recordField(root, 'horoscope')),
  );

  return lines.join('\n').trim();
};
