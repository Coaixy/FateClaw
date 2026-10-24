import { astro, util } from 'iztro';

const HOROSCOPE_SCOPES = [
  'decadal',
  'age',
  'yearly',
  'monthly',
  'daily',
  'hourly',
] as const;

type HoroscopeScope = (typeof HOROSCOPE_SCOPES)[number];
type ZiweiGender = 'male' | 'female';
type ZiweiAstrolabe = ReturnType<typeof astro.bySolar>;
type ZiweiConfig = Parameters<typeof astro.config>[0];
type ZiweiDayDivide = ZiweiConfig['dayDivide'];
type ZiweiYearDivide = ZiweiConfig['yearDivide'];
type ZiweiHoroscopeDivide = ZiweiConfig['horoscopeDivide'];
type ZiweiAgeDivide = ZiweiConfig['ageDivide'];
type ZiweiHoroscope = ReturnType<ZiweiAstrolabe['horoscope']>;
type ZiweiPalace = ZiweiAstrolabe['palaces'][number];
type ZiweiStar = ZiweiPalace['majorStars'][number];
type ZiweiYearlyHoroscope = ZiweiHoroscope['yearly'];

const ANNUAL_MUTAGEN_LABELS = ['化禄', '化权', '化科', '化忌'] as const;
const MUTAGEN_KEYS = ['禄', '权', '科', '忌'] as const;

type MutagenKey = (typeof MUTAGEN_KEYS)[number];
type MutagenLabel = (typeof ANNUAL_MUTAGEN_LABELS)[number];

interface ZiweiInput {
  solarDate?: string;
  hour?: number;
  minute?: number;
  gender?: string;
  fixLeap?: boolean;
  dayDivide?: ZiweiDayDivide;
  yearDivide?: ZiweiYearDivide;
  horoscopeDivide?: ZiweiHoroscopeDivide;
  ageDivide?: ZiweiAgeDivide;
  horoscope?: {
    date?: string;
    scopes?: HoroscopeScope[];
  };
}

type FormattedStar = Pick<ZiweiStar, 'name' | 'brightness' | 'mutagen'>;
type FormattedPalace = Pick<
  ZiweiPalace,
  | 'name'
  | 'isBodyPalace'
  | 'isOriginalPalace'
  | 'heavenlyStem'
  | 'earthlyBranch'
  | 'changsheng12'
  | 'boshi12'
  | 'jiangqian12'
  | 'suiqian12'
  | 'decadal'
> & {
  majorStars: FormattedStar[];
  minorStars: FormattedStar[];
  adjectiveStars: FormattedStar[];
};
type FormattedHoroscopeItem = {
  name: string;
  heavenlyStem: string;
  earthlyBranch: string;
  mutagen: string[];
  palaceNames: string[];
  nominalAge?: number;
};
type FormattedHoroscope = {
  solarDate: string;
  lunarDate: string;
} & Partial<Record<HoroscopeScope, FormattedHoroscopeItem>>;
type FormattedAnnualMutagen = {
  year: number;
  nominalAge: number;
  heavenlyStem: string;
  earthlyBranch: string;
  mutagens: Array<{
    label: (typeof ANNUAL_MUTAGEN_LABELS)[number];
    star: string;
  }>;
  palaceNames: string[];
};
type FormattedNatalMutagen = {
  mutagen: MutagenLabel;
  star: string;
  palace: string;
  palaceBranch: string;
  starType: string;
  brightness?: string;
};
type FormattedPalaceMutagenFlight = {
  sourcePalace: string;
  sourceBranch: string;
  sourceHeavenlyStem: string;
  mutagen: MutagenLabel;
  star: string;
  targetPalace?: string;
  targetBranch?: string;
  targetMarkers: string[];
  relations: string[];
};

/** 紫微斗数排盘的结构化输出，供前端命盘和模型可见 formatter 共用。 */
export interface ZiweiPaipanResult {
  solarDate: string;
  lunarDate: string;
  chineseDate: string;
  time: string;
  timeRange: string;
  sign: string;
  zodiac: string;
  soul: string;
  body: string;
  fiveElementsClass: string;
  earthlyBranchOfSoulPalace: string;
  earthlyBranchOfBodyPalace: string;
  palaces: FormattedPalace[];
  natalMutagens: FormattedNatalMutagen[];
  palaceMutagenFlights: FormattedPalaceMutagenFlight[];
  annualMutagenStartYear: number;
  annualMutagenEndYear: number;
  annualMutagens: FormattedAnnualMutagen[];
  horoscope?: FormattedHoroscope;
}

function hourToTimeIndex(hour: number, _minute = 0): number {
  if (hour === 23) return 12;
  if (hour === 0) return 0;
  return Math.floor((hour + 1) / 2);
}

function normalizeGender(gender: string | undefined): ZiweiGender {
  if (gender === '男') return 'male';
  if (gender === '女') return 'female';
  if (gender === 'male' || gender === 'female') return gender;
  throw new Error(`非法 gender: ${gender}`);
}

function normalizeDayDivide(value: unknown): ZiweiDayDivide {
  if (value === 'current' || value === 'forward') return value;
  throw new Error(`非法 dayDivide: ${String(value)}`);
}

function normalizeYearDivide(value: unknown): ZiweiYearDivide {
  if (value === 'normal' || value === 'exact') return value;
  throw new Error(`非法 yearDivide: ${String(value)}`);
}

function normalizeHoroscopeDivide(value: unknown): ZiweiHoroscopeDivide {
  if (value === 'normal' || value === 'exact') return value;
  throw new Error(`非法 horoscopeDivide: ${String(value)}`);
}

function normalizeAgeDivide(value: unknown): ZiweiAgeDivide {
  if (value === 'normal' || value === 'birthday') return value;
  throw new Error(`非法 ageDivide: ${String(value)}`);
}

function formatHoroscope(
  horoscope: ZiweiHoroscope,
  scopes: HoroscopeScope[],
): FormattedHoroscope {
  const out: FormattedHoroscope = {
    solarDate: horoscope.solarDate,
    lunarDate: horoscope.lunarDate,
  };
  for (const scope of scopes) {
    const scopeData = horoscope[scope];
    if (!scopeData) continue;
    const formatted: FormattedHoroscopeItem = {
      name: scopeData.name,
      heavenlyStem: scopeData.heavenlyStem,
      earthlyBranch: scopeData.earthlyBranch,
      mutagen: scopeData.mutagen,
      palaceNames: scopeData.palaceNames,
    };
    if ('nominalAge' in scopeData && scopeData.nominalAge !== undefined) {
      formatted.nominalAge = scopeData.nominalAge;
    }
    out[scope] = formatted;
  }
  return out;
}

function parseSolarYear(solarDate: string): number {
  const year = Number.parseInt(solarDate.slice(0, 4), 10);
  if (!Number.isInteger(year)) {
    throw new Error(`非法 solarDate: ${solarDate}`);
  }
  return year;
}

function formatMutagenLabel(key: MutagenKey | string): MutagenLabel {
  return `化${key}` as MutagenLabel;
}

function getMutagenOrder(mutagen: MutagenLabel): number {
  const key = mutagen.replace(/^化/, '') as MutagenKey;
  const index = MUTAGEN_KEYS.indexOf(key);
  return index >= 0 ? index : MUTAGEN_KEYS.length;
}

function getAllStars(palace: ZiweiPalace): ZiweiStar[] {
  return [...palace.majorStars, ...palace.minorStars, ...palace.adjectiveStars];
}

function findStarPalace(
  astrolabe: ZiweiAstrolabe,
  starName: string,
): ZiweiPalace | undefined {
  try {
    return astrolabe.star(starName as never).palace();
  } catch {
    return undefined;
  }
}

function formatPalaceMarkers(palace: ZiweiPalace | undefined): string[] {
  if (!palace) return [];
  return [
    palace.isBodyPalace ? '身宫' : undefined,
    palace.isOriginalPalace ? '来因宫' : undefined,
  ].filter((marker): marker is string => Boolean(marker));
}

function formatFlightRelations(
  astrolabe: ZiweiAstrolabe,
  source: ZiweiPalace,
  target: ZiweiPalace | undefined,
): string[] {
  const relations = ['飞入'];
  if (!target) return relations;

  const surrounded = astrolabe.surroundedPalaces(source.name);
  if (target.index === source.index) {
    relations.push('自化');
  }
  if (target.index === surrounded.opposite.index) {
    relations.push('对宫');
  }
  if (
    target.index === surrounded.target.index ||
    target.index === surrounded.opposite.index ||
    target.index === surrounded.wealth.index ||
    target.index === surrounded.career.index
  ) {
    relations.push('三方四正');
  }
  return Array.from(new Set(relations));
}

function getMaxDecadalAge(astrolabe: ZiweiAstrolabe): number {
  const ages = astrolabe.palaces.flatMap((palace) => {
    const range = palace.decadal.range;
    return Array.isArray(range) ? range : [];
  });
  const maxAge = Math.max(...ages.filter(Number.isFinite));
  return Number.isFinite(maxAge) ? maxAge : 120;
}

function formatAnnualMutagen(
  year: number,
  birthYear: number,
  yearly: ZiweiYearlyHoroscope,
): FormattedAnnualMutagen {
  return {
    year,
    nominalAge: year - birthYear + 1,
    heavenlyStem: yearly.heavenlyStem,
    earthlyBranch: yearly.earthlyBranch,
    mutagens: yearly.mutagen.map((star, index) => ({
      label: ANNUAL_MUTAGEN_LABELS[index] ?? '化忌',
      star,
    })),
    palaceNames: yearly.palaceNames,
  };
}

function buildAnnualMutagens(
  astrolabe: ZiweiAstrolabe,
): FormattedAnnualMutagen[] {
  const birthYear = parseSolarYear(astrolabe.solarDate);
  const maxAge = getMaxDecadalAge(astrolabe);

  return Array.from({ length: maxAge }, (_, index) => {
    const year = birthYear + index;
    // 取年中日期避开立春/农历年初等流年切换边界，稳定表达该公历年的年度四化。
    const yearly = astrolabe.horoscope(`${year}-06-15`).yearly;
    return formatAnnualMutagen(year, birthYear, yearly);
  });
}

function buildNatalMutagens(
  astrolabe: ZiweiAstrolabe,
): FormattedNatalMutagen[] {
  return astrolabe.palaces
    .flatMap((palace) =>
      getAllStars(palace).flatMap((star) => {
        if (!star.mutagen) return [];
        return [
          {
            mutagen: formatMutagenLabel(star.mutagen),
            star: star.name,
            palace: palace.name,
            palaceBranch: palace.earthlyBranch,
            starType: star.type,
            brightness: star.brightness || undefined,
          },
        ];
      }),
    )
    .sort(
      (left, right) =>
        getMutagenOrder(left.mutagen) - getMutagenOrder(right.mutagen),
    );
}

function buildPalaceMutagenFlights(
  astrolabe: ZiweiAstrolabe,
): FormattedPalaceMutagenFlight[] {
  return astrolabe.palaces.flatMap((source) => {
    const stars = util.getMutagensByHeavenlyStem(source.heavenlyStem);
    return MUTAGEN_KEYS.flatMap((mutagenKey, index) => {
      const star = stars[index];
      if (!star) return [];
      const target = findStarPalace(astrolabe, star);
      return [
        {
          sourcePalace: source.name,
          sourceBranch: source.earthlyBranch,
          sourceHeavenlyStem: source.heavenlyStem,
          mutagen: formatMutagenLabel(mutagenKey),
          star,
          targetPalace: target?.name,
          targetBranch: target?.earthlyBranch,
          targetMarkers: formatPalaceMarkers(target),
          relations: formatFlightRelations(astrolabe, source, target),
        },
      ];
    });
  });
}

function formatStar(star: ZiweiStar): FormattedStar {
  return {
    name: star.name,
    brightness: star.brightness,
    mutagen: star.mutagen,
  };
}

function formatAstrolabe(astrolabe: ZiweiAstrolabe): ZiweiPaipanResult {
  const annualMutagens = buildAnnualMutagens(astrolabe);
  const natalMutagens = buildNatalMutagens(astrolabe);
  const palaceMutagenFlights = buildPalaceMutagenFlights(astrolabe);

  return {
    solarDate: astrolabe.solarDate,
    lunarDate: astrolabe.lunarDate,
    chineseDate: astrolabe.chineseDate,
    time: astrolabe.time,
    timeRange: astrolabe.timeRange,
    sign: astrolabe.sign,
    zodiac: astrolabe.zodiac,
    soul: astrolabe.soul,
    body: astrolabe.body,
    fiveElementsClass: astrolabe.fiveElementsClass,
    earthlyBranchOfSoulPalace: astrolabe.earthlyBranchOfSoulPalace,
    earthlyBranchOfBodyPalace: astrolabe.earthlyBranchOfBodyPalace,
    palaces: astrolabe.palaces.map((palace) => ({
      name: palace.name,
      isBodyPalace: palace.isBodyPalace,
      isOriginalPalace: palace.isOriginalPalace,
      heavenlyStem: palace.heavenlyStem,
      earthlyBranch: palace.earthlyBranch,
      changsheng12: palace.changsheng12,
      boshi12: palace.boshi12,
      jiangqian12: palace.jiangqian12,
      suiqian12: palace.suiqian12,
      majorStars: palace.majorStars.map(formatStar),
      minorStars: palace.minorStars.map(formatStar),
      adjectiveStars: palace.adjectiveStars.map(formatStar),
      decadal: palace.decadal,
    })),
    natalMutagens,
    palaceMutagenFlights,
    annualMutagenStartYear:
      annualMutagens[0]?.year ?? parseSolarYear(astrolabe.solarDate),
    annualMutagenEndYear:
      annualMutagens.at(-1)?.year ?? parseSolarYear(astrolabe.solarDate),
    annualMutagens,
  };
}

export async function runZiweiPaipan(
  input: Record<string, unknown>,
): Promise<ZiweiPaipanResult> {
  const {
    solarDate,
    hour,
    minute = 0,
    gender,
    fixLeap = true,
    dayDivide = 'forward',
    yearDivide = 'normal',
    horoscopeDivide = 'normal',
    ageDivide = 'normal',
    horoscope,
  } = input as ZiweiInput;

  if (!solarDate || hour === undefined || !gender) {
    throw new Error('缺少必填参数: solarDate, hour, gender');
  }

  const timeIndex = hourToTimeIndex(hour, minute);
  const astrolabe = astro.withOptions({
    type: 'solar',
    dateStr: solarDate,
    timeIndex,
    gender: normalizeGender(gender),
    fixLeap,
    language: 'zh-CN',
    config: {
      dayDivide: normalizeDayDivide(dayDivide),
      yearDivide: normalizeYearDivide(yearDivide),
      horoscopeDivide: normalizeHoroscopeDivide(horoscopeDivide),
      ageDivide: normalizeAgeDivide(ageDivide),
    },
  });

  const result = formatAstrolabe(astrolabe);

  if (horoscope?.date) {
    const scopes = horoscope.scopes ?? ['decadal', 'yearly'];
    const invalid = scopes.filter((scope) => !HOROSCOPE_SCOPES.includes(scope));
    if (invalid.length) {
      throw new Error(`非法 horoscope scope: ${invalid.join(',')}`);
    }
    result.horoscope = formatHoroscope(
      astrolabe.horoscope(horoscope.date),
      scopes,
    );
  }

  return result;
}
