import { astro } from 'iztro';

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
type ZiweiHoroscope = ReturnType<ZiweiAstrolabe['horoscope']>;
type ZiweiPalace = ZiweiAstrolabe['palaces'][number];
type ZiweiStar = ZiweiPalace['majorStars'][number];

interface ZiweiInput {
  solarDate?: string;
  hour?: number;
  minute?: number;
  gender?: string;
  fixLeap?: boolean;
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
  | 'decadal'
> & {
  majorStars: FormattedStar[];
  minorStars: FormattedStar[];
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

function formatStar(star: ZiweiStar): FormattedStar {
  return {
    name: star.name,
    brightness: star.brightness,
    mutagen: star.mutagen,
  };
}

function formatAstrolabe(astrolabe: ZiweiAstrolabe): ZiweiPaipanResult {
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
      majorStars: palace.majorStars.map(formatStar),
      minorStars: palace.minorStars.map(formatStar),
      decadal: palace.decadal,
    })),
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
    horoscope,
  } = input as ZiweiInput;

  if (!solarDate || hour === undefined || !gender) {
    throw new Error('缺少必填参数: solarDate, hour, gender');
  }

  const timeIndex = hourToTimeIndex(hour, minute);
  const astrolabe = astro.bySolar(
    solarDate,
    timeIndex,
    normalizeGender(gender),
    fixLeap,
    'zh-CN',
  );
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
