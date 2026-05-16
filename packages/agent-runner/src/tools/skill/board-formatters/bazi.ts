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

const SKILL = 'bazi-paipan';
const PILLAR_KEYS = ['year', 'month', 'day', 'hour'] as const;
const PILLAR_LABELS = ['年', '月', '日', '时'] as const;

interface ParsedBaziBoard {
  root: Record<string, unknown>;
  bazi: Record<string, unknown>;
  pillars: Record<string, unknown>;
  specialSigns?: Record<string, unknown>;
  fortune?: Record<string, unknown>;
}

function parseBaziBoard(payload: unknown): ParsedBaziBoard {
  const root = asRecord(SKILL, payload, 'payload');
  const bazi = getRecord(root, 'bazi');
  if (!bazi) throw new Error(`[${SKILL}] 缺少 bazi 字段`);

  return {
    root,
    bazi,
    pillars: getRecord(bazi, 'pillars') ?? {},
    specialSigns: getRecord(bazi, 'specialSigns'),
    fortune: getRecord(root, 'fortune'),
  };
}

function formatHiddenStems(branch?: Record<string, unknown>): string {
  const hiddenStems = getArray(branch ?? {}, 'hideHeavenStems')
    .map((item) => asRecord(SKILL, item, 'hideHeavenStems[]'))
    .map((stem) =>
      joinNonEmpty([text(stem.name), text(stem.type), text(stem.element)], ''),
    );
  return hiddenStems.length > 0 ? `藏${hiddenStems.join('/')}` : '';
}

function formatPillarDetail(pillar: Record<string, unknown>): string {
  const stem = getRecord(pillar, 'heavenStem');
  const branch = getRecord(pillar, 'earthBranch');
  const hidden = formatHiddenStems(branch);
  const parts = [
    text(pillar.sixtyCycle),
    text(pillar.tenStar),
    hidden,
    text(pillar.terrain) ? `星运${text(pillar.terrain)}` : '',
    text(pillar.sound) ? `纳音${text(pillar.sound)}` : '',
  ];
  const stemElement = text(stem?.element);
  const branchElement = text(branch?.element);
  if (stemElement || branchElement) {
    parts.push(`五行${stemElement || '-'}${branchElement || '-'}`);
  }
  return joinNonEmpty(parts, ' ');
}

function formatPillar(
  label: string,
  pillar: Record<string, unknown> | undefined,
): string {
  return pillar ? `${label}: ${formatPillarDetail(pillar)}` : `${label}: 缺失`;
}

function formatBirthInfo(bazi: Record<string, unknown>): string[] {
  return compactLines([
    text(bazi.birthTime) ? `出生: ${text(bazi.birthTime)}` : null,
    text(bazi.gender) ? `性别: ${text(bazi.gender)}` : null,
    text(bazi.baziString) ? `八字: ${text(bazi.baziString)}` : null,
  ]);
}

function formatDayMaster(pillars: Record<string, unknown>): string | null {
  const dayPillar = getRecord(pillars, 'day');
  const dayStem = getRecord(dayPillar ?? {}, 'heavenStem');
  const dayMaster = joinNonEmpty(
    [text(dayStem?.name), text(dayStem?.element), text(dayStem?.yinYang)],
    '',
  );
  return dayMaster ? `日主: ${dayMaster}` : null;
}

function formatPillars(pillars: Record<string, unknown>): string[] {
  return PILLAR_KEYS.map((key, index) =>
    formatPillar(PILLAR_LABELS[index], getRecord(pillars, key)),
  );
}

function formatSpecialSigns(signs?: Record<string, unknown>): string | null {
  if (!signs) return null;
  const kongWang = getArray(signs, 'kongWang').map(text).join('');
  const line = joinNonEmpty(
    [
      labelValue('命宫', signs.ownSign),
      labelValue('身宫', signs.bodySign),
      kongWang ? `空亡${kongWang}` : '',
      labelValue('胎元', signs.fetalOrigin),
      labelValue('胎息', signs.fetalBreath),
      labelValue('旬', signs.xun),
    ],
    '；',
  );
  return line ? `神煞/附加: ${line}` : null;
}

function formatDecade(decade: Record<string, unknown>): string {
  const years = joinNonEmpty([text(decade.startYear), text(decade.endYear)], '-');
  const ages = joinNonEmpty([text(decade.startAge), text(decade.endAge)], '-');
  const detail = joinNonEmpty(
    [text(decade.tenStar), text(decade.terrain), text(decade.sound)],
    '/',
  );
  return joinNonEmpty(
    [
      years,
      text(decade.sixtyCycle),
      ages ? `${ages}岁` : '',
      detail ? `(${detail})` : '',
    ],
    '',
  );
}

function formatChildLimit(fortune: Record<string, unknown>): string | null {
  const childLimit = getRecord(fortune, 'childLimit');
  if (!childLimit) return null;
  const direction =
    childLimit.isForward === true
      ? '顺行'
      : childLimit.isForward === false
        ? '逆行'
        : '';
  const line = joinNonEmpty(
    [
      text(childLimit.startTime),
      text(childLimit.startAge) ? `${text(childLimit.startAge)}岁` : '',
      direction,
    ],
    ' ',
  );
  return line ? `起运: ${line}` : null;
}

function formatDecades(fortune: Record<string, unknown>): string | null {
  const decades = asRecordArray(
    SKILL,
    getArray(fortune, 'decades'),
    'fortune.decades',
  );
  return decades.length > 0
    ? `大运: ${decades.map(formatDecade).join('；')}`
    : null;
}

function formatAnnual(annual: Record<string, unknown>): string {
  const detail = joinNonEmpty([text(annual.tenStar), text(annual.terrain)], '/');
  return joinNonEmpty(
    [
      text(annual.year),
      text(annual.sixtyCycle),
      text(annual.age) ? `${text(annual.age)}岁` : '',
      detail ? `(${detail})` : '',
    ],
    '',
  );
}

function formatCurrentAnnual(
  annuals: Array<Record<string, unknown>>,
  currentYear: unknown,
): string | null {
  const currentAnnual = annuals.find(
    (annual) => Number(annual.year) === Number(currentYear),
  );
  return currentAnnual ? `当前流年: ${formatAnnual(currentAnnual)}` : null;
}

function formatAnnuals(fortune: Record<string, unknown>): string[] {
  const annuals = asRecordArray(
    SKILL,
    getArray(fortune, 'annuals'),
    'fortune.annuals',
  );
  if (annuals.length === 0) return [];
  return compactLines([
    formatCurrentAnnual(annuals, fortune.currentAnnualYear),
    `流年: ${annuals.map(formatAnnual).join('，')}`,
  ]);
}

function formatFortune(fortune?: Record<string, unknown>): string[] {
  if (!fortune) return [];
  return compactLines([
    formatChildLimit(fortune),
    formatDecades(fortune),
    ...formatAnnuals(fortune),
  ]);
}

export function formatBaziBoard(payload: unknown): string {
  const board = parseBaziBoard(payload);
  const lines = compactLines([
    '【八字排盘 AI摘要】',
    '#基本信息',
    ...formatBirthInfo(board.bazi),
    formatDayMaster(board.pillars),
    '#四柱',
    ...formatPillars(board.pillars),
    formatSpecialSigns(board.specialSigns),
    '#运限',
    ...formatFortune(board.fortune),
  ]);

  return lines.join('\n');
}
