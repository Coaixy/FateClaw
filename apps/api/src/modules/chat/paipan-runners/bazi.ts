import type {
  BaZiConfig,
  BaZiResult,
  DecadeFortuneInfo,
  FortuneResult,
  Gender,
} from 'bazi-ts-lib';
import { solarToLunar } from 'iching-shifa';

const SECTIONS = ['bazi', 'fortune', 'pattern'] as const;
const DEFAULT_DECADE_COUNT = 11;

type BaziLib = typeof import('bazi-ts-lib');
type AnnualFortuneRange = ReturnType<BaziLib['getAnnualFortuneRange']>;
type BaziPattern = ReturnType<BaziLib['getPattern']>;

let baziLibPromise: Promise<BaziLib> | null = null;

type BaziSection = (typeof SECTIONS)[number];

interface BaziInput {
  solarDate?: string;
  hour?: number;
  minute?: number;
  gender?: string;
  zishiMode?: BaZiConfig['zishiMode'];
  childLimitMode?: BaZiConfig['childLimitMode'];
  decadeCount?: number;
  include?: BaziSection[];
}

type ChildhoodFortune = Omit<DecadeFortuneInfo, 'tenStar' | 'element'> & {
  tenStar: string;
  element: string;
  label: string;
};

type BaziFortuneOutput = {
  childLimit: FortuneResult['childLimit'];
  decades: Array<DecadeFortuneInfo | ChildhoodFortune>;
  annuals: AnnualFortuneRange;
  annualStartYear: number;
  annualEndYear: number;
  currentAnnualYear: number;
  childhood?: ChildhoodFortune;
};

export interface BaziPaipanResult {
  bazi?: BaZiResult;
  fortune?: BaziFortuneOutput;
  pattern?: BaziPattern;
}

async function loadBaziLib(): Promise<BaziLib> {
  if (!baziLibPromise) {
    baziLibPromise = importBaziLibWithoutDemoOutput();
  }
  return baziLibPromise;
}

async function importBaziLibWithoutDemoOutput(): Promise<BaziLib> {
  const originalArgv1 = process.argv[1];
  if (originalArgv1?.includes('index.ts')) {
    // bazi-ts-lib 1.0.1 在入口里用 process.argv[1] 判断并打印 demo。
    process.argv[1] = originalArgv1.replaceAll('index.ts', 'app-entry.ts');
  }

  try {
    return await import('bazi-ts-lib');
  } finally {
    if (originalArgv1 !== undefined) {
      process.argv[1] = originalArgv1;
    }
  }
}

function normalizeGender(gender: string | undefined): Gender {
  if (gender === 'male') return '男';
  if (gender === 'female') return '女';
  if (gender === '男' || gender === '女') return gender;
  throw new Error(`非法 gender: ${gender}`);
}

function buildBirthDate(solarDate: string, hour: number, minute: number): Date {
  const [year, month, day] = solarDate.split('-').map(Number);
  if (!year || !month || !day) throw new Error(`非法 solarDate: ${solarDate}`);
  return new Date(year, month - 1, day, hour, minute, 0);
}

function buildFortuneSection(
  bazi: BaZiResult,
  fortuneSource: FortuneResult,
  birthDate: Date,
  config: Partial<BaZiConfig>,
  baziLib: BaziLib,
): BaziFortuneOutput {
  const birthYear = birthDate.getFullYear();
  const currentAnnualYear = fortuneSource.currentAnnual?.year ?? birthYear;
  const lastDecadeEndYear =
    fortuneSource.decades.at(-1)?.endYear ?? currentAnnualYear;

  // 流年必须全量返回，避免只给窗口时让下游误判年份范围或遗漏上下文。
  const annuals = baziLib.getAnnualFortuneRange(
    bazi,
    birthDate,
    birthYear,
    lastDecadeEndYear,
    config,
  );

  return {
    childLimit: fortuneSource.childLimit,
    decades: fortuneSource.decades,
    annuals,
    annualStartYear: birthYear,
    annualEndYear: lastDecadeEndYear,
    currentAnnualYear,
  };
}

function buildChildhoodFortune(birthDate: Date): ChildhoodFortune {
  const birthYear = birthDate.getFullYear();
  return {
    index: -1,
    sixtyCycle: '',
    heavenStem: '',
    earthBranch: '',
    sound: '',
    startAge: 1,
    endAge: undefined as unknown as number,
    startYear: birthYear,
    endYear: undefined as unknown as number,
    tenStar: '',
    terrain: '',
    element: '',
    label: '小运',
  };
}

function withReferenceDecadeShape(
  fortune: BaziFortuneOutput,
  birthDate: Date,
): BaziFortuneOutput {
  const firstDecade = fortune.decades[0];
  if (!firstDecade) return fortune;

  const childhood = {
    ...buildChildhoodFortune(birthDate),
    endAge: firstDecade.startAge - 1,
    endYear: firstDecade.startYear - 1,
  };

  return {
    ...fortune,
    childhood,
    decades: [childhood, ...fortune.decades],
  };
}

function getReferenceYearPillar(birthDate: Date): string {
  return solarToLunar(
    birthDate.getFullYear(),
    birthDate.getMonth() + 1,
    birthDate.getDate(),
    birthDate.getHours(),
  ).yearGanZhi.gz;
}

function withReferenceYearPillar(
  bazi: BaZiResult,
  birthDate: Date,
  gender: Gender,
  config: Partial<BaZiConfig>,
  baziLib: BaziLib,
): BaZiResult {
  const referenceYearPillar = getReferenceYearPillar(birthDate);
  if (bazi.pillars.year.sixtyCycle === referenceYearPillar) return bazi;

  const referenceBazi = baziLib.getBaZiBySiZhu(
    referenceYearPillar,
    bazi.pillars.month.sixtyCycle,
    bazi.pillars.day.sixtyCycle,
    bazi.pillars.hour.sixtyCycle,
    gender,
    config,
  );
  return {
    ...referenceBazi,
    birthTime: bazi.birthTime,
  };
}

export async function runBaziPaipan(
  input: Record<string, unknown>,
): Promise<BaziPaipanResult> {
  const {
    solarDate,
    hour,
    minute = 0,
    gender,
    zishiMode = 'early',
    childLimitMode = 'default',
    decadeCount = DEFAULT_DECADE_COUNT,
    include,
  } = input as BaziInput;

  if (!solarDate || hour === undefined || !gender) {
    throw new Error('缺少必填参数: solarDate, hour, gender');
  }

  const sections = include ?? SECTIONS;
  const invalid = sections.filter((section) => !SECTIONS.includes(section));
  if (invalid.length) throw new Error(`非法 include: ${invalid.join(',')}`);

  const birthDate = buildBirthDate(solarDate, hour, minute);
  const config = { zishiMode, childLimitMode, decadeCount };
  const normalizedGender = normalizeGender(gender);
  const baziLib = await loadBaziLib();
  const bazi = withReferenceYearPillar(
    baziLib.getBaZi(birthDate, normalizedGender, config),
    birthDate,
    normalizedGender,
    config,
    baziLib,
  );

  const result: BaziPaipanResult = {};
  for (const section of sections) {
    if (section === 'bazi') {
      result.bazi = bazi;
      continue;
    }
    if (section === 'fortune') {
      const fortune = baziLib.getFortune(bazi, birthDate, config);
      result.fortune = withReferenceDecadeShape(
        buildFortuneSection(bazi, fortune, birthDate, config, baziLib),
        birthDate,
      );
      continue;
    }
    if (section === 'pattern') {
      result.pattern = baziLib.getPattern(bazi);
      continue;
    }
  }

  return result;
}
