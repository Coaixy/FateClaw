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

function formatPalaceDisplay(
  palaceName?: string,
  branch?: string,
  markers: string[] = [],
): string | undefined {
  if (!palaceName) return undefined;
  const name = palaceName.endsWith('宫') ? palaceName : `${palaceName}宫`;
  const details = joinList([
    branch,
    markers.length > 0 ? markers.join('/') : undefined,
  ]);
  return details ? `${name}（${details}）` : name;
}

function formatNatalMutagen(value: unknown): string | undefined {
  const item = asRecord(value);
  if (!item) return undefined;
  const mutagen = textField(item, 'mutagen');
  const star = textField(item, 'star');
  const palace = formatPalaceDisplay(
    textField(item, 'palace'),
    textField(item, 'palaceBranch'),
  );
  if (!mutagen || !star || !palace) return undefined;
  const brightness = textField(item, 'brightness');
  return `${mutagen}${star} -> ${palace}${brightness ? `（${brightness}）` : ''}`;
}

function formatPalaceMutagenFlight(value: unknown): string | undefined {
  const flight = asRecord(value);
  if (!flight) return undefined;
  const sourcePalace = textField(flight, 'sourcePalace');
  const sourceStem = textField(flight, 'sourceHeavenlyStem');
  const sourceBranch = textField(flight, 'sourceBranch');
  const source = formatPalaceDisplay(
    sourcePalace,
    joinText([sourceStem, sourceBranch], ''),
  );
  const mutagen = textField(flight, 'mutagen');
  const star = textField(flight, 'star');
  if (!source || !mutagen || !star) return undefined;
  const target = formatPalaceDisplay(
    textField(flight, 'targetPalace'),
    textField(flight, 'targetBranch'),
    scalarArray(flight.targetMarkers),
  );
  const relations = scalarArray(flight.relations);
  const relationText = relations.length > 0 ? ` [${relations.join('、')}]` : '';
  return `${source}${mutagen}${star} -> ${target ?? '未定位'}${relationText}`;
}

function formatAnnualMutagenPair(value: unknown): string | undefined {
  const pair = asRecord(value);
  if (!pair) return undefined;
  const label = textField(pair, 'label');
  const star = textField(pair, 'star');
  if (!label || !star) return undefined;
  return `${label}${star}`;
}

function formatAnnualMutagen(value: unknown): string | undefined {
  const annual = asRecord(value);
  if (!annual) return undefined;
  const year = textField(annual, 'year');
  const age = textField(annual, 'nominalAge');
  const stemBranch = joinText(
    [textField(annual, 'heavenlyStem'), textField(annual, 'earthlyBranch')],
    '',
  );
  const mutagens = arrayField(annual, 'mutagens')
    .map(formatAnnualMutagenPair)
    .filter((item): item is string => Boolean(item));
  if (!year && !stemBranch && mutagens.length === 0) return undefined;
  const title =
    `${year ? `${year}年` : ''}${age ? `（${age}岁）` : ''}${stemBranch ? ` ${stemBranch}` : ''}`.trim();
  return mutagens.length > 0 ? `${title}：${mutagens.join('、')}` : title;
}

function formatAnnualMutagens(root: Record<string, unknown>): string[] {
  const annuals = arrayField(root, 'annualMutagens')
    .map(formatAnnualMutagen)
    .filter((line): line is string => Boolean(line));
  if (annuals.length === 0) return [];

  const range =
    textField(root, 'annualMutagenStartYear') &&
    textField(root, 'annualMutagenEndYear')
      ? `流年四化范围：${textField(root, 'annualMutagenStartYear')}-${textField(root, 'annualMutagenEndYear')}年`
      : undefined;
  return [range, ...annuals].filter((line): line is string => Boolean(line));
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

  pushSection(
    lines,
    '生年四化',
    arrayField(root, 'natalMutagens').map(formatNatalMutagen),
  );
  pushSection(
    lines,
    '宫干飞化',
    arrayField(root, 'palaceMutagenFlights').map(formatPalaceMutagenFlight),
  );
  pushSection(lines, '十二宫', arrayField(root, 'palaces').map(formatPalace));
  pushSection(lines, '流年四化', formatAnnualMutagens(root));
  pushSection(
    lines,
    '运盘叠加',
    formatHoroscope(recordField(root, 'horoscope')),
  );

  return lines.join('\n').trim();
};
