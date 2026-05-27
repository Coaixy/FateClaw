import {
  Qimen,
  type Gong,
  type HourChabuPan,
  type QimenDateInput,
} from 'kinqimen';
import { calcXunKong, solarToLunar } from 'iching-shifa';

const SHORT_GOD_MAP: Record<string, string> = {
  值符: '符',
  螣蛇: '蛇',
  腾蛇: '蛇',
  太阴: '阴',
  六合: '合',
  白虎: '虎',
  玄武: '玄',
  九地: '地',
  九天: '天',
};
const GONG_BY_NUMBER = [
  '坎',
  '坤',
  '震',
  '巽',
  '中',
  '乾',
  '兑',
  '艮',
  '离',
] as const;
const GONG_NUMBER: Record<string, number> = {
  坎: 1,
  坤: 2,
  震: 3,
  巽: 4,
  中: 5,
  乾: 6,
  兑: 7,
  艮: 8,
  离: 9,
};
const GOD_PAN_YANG: Record<number, string[]> = {
  1: ['符', '玄', '阴', '合', '', '天', '地', '蛇', '虎'],
  2: ['合', '符', '玄', '地', '', '阴', '蛇', '虎', '天'],
  3: ['地', '合', '符', '蛇', '', '玄', '虎', '天', '阴'],
  4: ['玄', '阴', '天', '符', '', '虎', '合', '地', '蛇'],
  5: ['合', '符', '玄', '地', '', '阴', '蛇', '虎', '天'],
  6: ['蛇', '地', '合', '虎', '', '符', '天', '阴', '玄'],
  7: ['阴', '天', '虎', '玄', '', '蛇', '符', '合', '地'],
  8: ['天', '虎', '蛇', '阴', '', '地', '玄', '符', '合'],
  9: ['虎', '蛇', '地', '天', '', '合', '阴', '玄', '符'],
};
const GOD_PAN_YIN: Record<number, string[]> = {
  1: ['符', '合', '地', '玄', '', '蛇', '阴', '天', '虎'],
  2: ['玄', '符', '合', '阴', '', '地', '天', '虎', '蛇'],
  3: ['阴', '玄', '符', '天', '', '合', '虎', '蛇', '地'],
  4: ['合', '地', '蛇', '符', '', '虎', '玄', '阴', '天'],
  5: ['玄', '符', '合', '阴', '', '地', '天', '虎', '蛇'],
  6: ['天', '阴', '玄', '虎', '', '符', '蛇', '地', '合'],
  7: ['地', '蛇', '虎', '合', '', '天', '符', '玄', '阴'],
  8: ['蛇', '虎', '天', '地', '', '阴', '合', '符', '玄'],
  9: ['虎', '天', '阴', '蛇', '', '玄', '地', '合', '符'],
};

interface QimenInput {
  solarDate?: string;
  hour?: number;
  minute?: number;
}

export type QimenPaipanResult = Omit<HourChabuPan, '旬空' | '星' | '神'> & {
  旬空: HourChabuPan['旬空'] & Record<'年空' | '月空', string>;
  星: Record<string, string>;
  神: Record<string, string>;
};

function resolveDateInput(input: QimenInput): QimenDateInput {
  if (input.solarDate && input.hour !== undefined) {
    const [year, month, day] = input.solarDate.split('-').map(Number);
    if (!year || !month || !day)
      throw new Error(`非法 solarDate: ${input.solarDate}`);
    return {
      year,
      month,
      day,
      hour: input.hour,
      minute: input.minute ?? 0,
    };
  }
  if (input.solarDate || input.hour !== undefined) {
    throw new Error('solarDate 和 hour 必须同时传入，或都不传（使用当前时间）');
  }
  const now = new Date();
  return {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    day: now.getDate(),
    hour: now.getHours(),
    minute: now.getMinutes(),
  };
}

function buildFourPillarKong(
  dateInput: QimenDateInput,
): QimenPaipanResult['旬空'] {
  const lunar = solarToLunar(
    dateInput.year,
    dateInput.month,
    dateInput.day,
    dateInput.hour,
  );
  return {
    年空: calcXunKong(lunar.yearGanZhi.gz),
    月空: calcXunKong(lunar.monthGanZhi.gz),
    日空: calcXunKong(lunar.dayGanZhi.gz),
    时空: calcXunKong(lunar.hourGanZhi.gz),
  };
}

function referenceShenPan(
  yinYangDun: string | undefined,
  zhifuStarGong: readonly string[],
): Record<string, string> {
  const [, palace] = zhifuStarGong;
  const palaceNumber = palace ? GONG_NUMBER[palace] : undefined;
  const values =
    palaceNumber === undefined
      ? undefined
      : (yinYangDun === '阳' ? GOD_PAN_YANG : GOD_PAN_YIN)[palaceNumber];
  if (!values) throw new Error(`无法识别值符落宫: ${palace ?? ''}`);

  return Object.fromEntries(
    values
      .map((god, index) => [GONG_BY_NUMBER[index], god])
      .filter(([, god]) => god),
  );
}

function normalizeQimenPan(
  pan: HourChabuPan,
  dateInput: QimenDateInput,
): QimenPaipanResult {
  const zhifuStarGong = pan.值符值使?.值符星宫;
  const normalized: QimenPaipanResult = {
    ...pan,
    旬空: buildFourPillarKong(dateInput),
    星: Object.fromEntries(
      Object.entries(pan.星 ?? {}).map(([palace, star]) => [
        palace,
        star === '禽' ? '芮禽' : star,
      ]),
    ),
    神: Object.fromEntries(
      Object.entries(pan.神 ?? {}).map(([palace, god]) => [
        palace,
        SHORT_GOD_MAP[String(god)] ?? String(god),
      ]),
    ),
  };

  if (Array.isArray(zhifuStarGong)) {
    const referenceGods = referenceShenPan(pan.排局?.[0], zhifuStarGong);
    normalized.神 = referenceGods;
  }

  return normalized;
}

export async function runQimenPaipan(
  input: Record<string, unknown>,
): Promise<QimenPaipanResult> {
  const dateInput = resolveDateInput(input as QimenInput);
  return normalizeQimenPan(new Qimen(dateInput).pan(), dateInput);
}
