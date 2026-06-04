import {
  Qimen,
  type Gong,
  type HourChabuPan,
  type QimenDateInput,
} from 'kinqimen';
import { calcXunKong, solarToLunar } from 'iching-shifa';

type GongGanPan = Partial<Record<Gong, string>>;
type FullGongGanPan = Record<Gong, string>;
type KinqimenChangshengItem = { gan: string; changsheng: Record<string, string> };
type KinqimenMenpoItem = {
  door: string;
  gong: string;
  doorWuxing: string;
  gongWuxing: string;
};
type KinqimenJixingItem = { gong: string; gan: string };

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

interface ChineseZhifuZhishi {
  值符天干: [string, string];
  值符星宫: [string, string];
  值使门宫: [string, string];
}

interface ChineseMaXing {
  天马: string;
  丁马: string;
  驿马: string;
}

interface ChineseChangshengItem {
  天干: string;
  长生: Record<string, string>;
}

interface ChineseMenpoItem {
  门: string;
  宫: string;
  门五行: string;
  宫五行: string;
}

interface ChineseJixingItem {
  宫1?: string;
  宫2?: string;
  类型?: string;
  六仪?: string;
  落宫?: string;
}

/** 奇门排盘对外结果，保持中文字段契约以兼容前端图表和 formatter。 */
export interface QimenPaipanResult {
  排盘方式: HourChabuPan['method'];
  干支: string;
  旬首: string;
  旬空: Record<'年空' | '月空' | '日空' | '时空', string>;
  局日: string;
  排局: string;
  节气: string;
  值符值使: ChineseZhifuZhishi;
  天乙: string;
  天盘: GongGanPan;
  地盘: FullGongGanPan;
  门: GongGanPan;
  星: GongGanPan;
  神: GongGanPan;
  暗干: FullGongGanPan;
  马星: ChineseMaXing;
  长生运: {
    天盘: Record<string, ChineseChangshengItem>;
    地盘: Record<string, ChineseChangshengItem>;
  };
  门迫: ChineseMenpoItem[];
  击刑: ChineseJixingItem[];
}

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

function normalizeGanPan(pan: Partial<Record<string, string>>): GongGanPan {
  return Object.fromEntries(
    Object.entries(pan).map(([palace, gan]) => [palace, String(gan)]),
  ) as GongGanPan;
}

function normalizeFullGanPan(pan: Record<string, string>): FullGongGanPan {
  return normalizeGanPan(pan) as FullGongGanPan;
}

function normalizeStarPan(pan: HourChabuPan['starPan']): GongGanPan {
  return Object.fromEntries(
    Object.entries(pan).map(([palace, star]) => [
      palace,
      star === '禽' ? '芮禽' : String(star),
    ]),
  ) as GongGanPan;
}

function normalizeGodPan(pan: HourChabuPan['godPan']): GongGanPan {
  return Object.fromEntries(
    Object.entries(pan).map(([palace, god]) => [
      palace,
      SHORT_GOD_MAP[String(god)] ?? String(god),
    ]),
  ) as GongGanPan;
}

function normalizeChangshengPan(
  pan: Record<string, KinqimenChangshengItem>,
): Record<string, ChineseChangshengItem> {
  return Object.fromEntries(
    Object.entries(pan).map(([palace, item]) => [
      palace,
      {
        天干: item.gan,
        长生: item.changsheng,
      },
    ]),
  );
}

function normalizeMenpo(pan: KinqimenMenpoItem[]): ChineseMenpoItem[] {
  return pan.map((item) => ({
    门: item.door,
    宫: item.gong,
    门五行: item.doorWuxing,
    宫五行: item.gongWuxing,
  }));
}

function normalizeJixing(pan: KinqimenJixingItem[]): ChineseJixingItem[] {
  return pan.map((item) => ({
    宫1: item.gan,
    宫2: item.gong,
    类型: '击刑',
    六仪: item.gan.slice(-1),
    落宫: item.gong,
  }));
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
  const zhifuStarGong = pan.zhifuZhishi.zhifuStarGong;
  const normalized: QimenPaipanResult = {
    排盘方式: pan.method,
    干支: pan.ganzhi,
    旬首: pan.xunHead,
    旬空: buildFourPillarKong(dateInput),
    局日: pan.juDay,
    排局: pan.ju,
    节气: pan.jieqi,
    值符值使: {
      值符天干: pan.zhifuZhishi.zhifuGan,
      值符星宫: zhifuStarGong,
      值使门宫: pan.zhifuZhishi.zhishiDoorGong,
    },
    天乙: pan.tianyi,
    天盘: normalizeGanPan(pan.skyPan),
    地盘: normalizeFullGanPan(pan.earthPan),
    门: normalizeGanPan(pan.doorPan),
    星: normalizeStarPan(pan.starPan),
    神: normalizeGodPan(pan.godPan),
    暗干: normalizeFullGanPan(pan.anganPan),
    马星: {
      天马: pan.maXing.tianMa,
      丁马: pan.maXing.dingMa,
      驿马: pan.maXing.yiMa,
    },
    长生运: {
      天盘: normalizeChangshengPan(pan.changshengYun.skyPan),
      地盘: normalizeChangshengPan(pan.changshengYun.earthPan),
    },
    门迫: normalizeMenpo(pan.menpo),
    击刑: normalizeJixing(pan.jixing),
  };

  if (Array.isArray(zhifuStarGong)) {
    const referenceGods = referenceShenPan(pan.ju?.[0], zhifuStarGong);
    normalized.神 = referenceGods;
  }

  return normalized;
}

/** 按指定公历时间执行奇门拆补法排盘，并输出前端兼容的中文字段。 */
export async function runQimenPaipan(
  input: Record<string, unknown>,
): Promise<QimenPaipanResult> {
  const dateInput = resolveDateInput(input as QimenInput);
  return normalizeQimenPan(new Qimen(dateInput).pan(), dateInput);
}
