import {
  DI_ZHI,
  getWuXingRelation,
  type WuXing,
  type WuXingRelation,
} from 'iching-shifa';

import { formatGenericPaipan } from './fallback.js';
import type { PaipanFormatter } from './types.js';
import {
  arrayField,
  asRecord,
  formatQueryTime,
  joinList,
  pushSection,
  recordField,
  scalarArray,
  scalarText,
  textField,
} from './utils.js';

const YAO_LABELS: Record<number, string> = {
  1: '初爻',
  2: '二爻',
  3: '三爻',
  4: '四爻',
  5: '五爻',
  6: '上爻',
};

function formatGanZhi(root: Record<string, unknown>): string | undefined {
  const values = [
    ['ganZhiYear', '年'],
    ['ganZhiMonth', '月'],
    ['ganZhiDay', '日'],
    ['ganZhiHour', '时'],
  ] as const;
  const text = values
    .map(([key, label]) => {
      const record = recordField(root, key);
      const gz = record ? textField(record, 'gz') : undefined;
      return gz ? `${gz}${label}` : undefined;
    })
    .filter(Boolean)
    .join(' ');
  return text || undefined;
}

function movingPositions(gua: Record<string, unknown> | undefined): number[] {
  if (!gua) return [];
  return arrayField(gua, 'yaoList').flatMap((yao) => {
    const record = asRecord(yao);
    if (!record || record.isMoving !== true) return [];
    const position = Number(record.position);
    return Number.isFinite(position) ? [position] : [];
  });
}

function formatGuaSummary(label: string, value: unknown): string | undefined {
  const gua = asRecord(value);
  if (!gua) return undefined;
  const name = textField(gua, 'guaName');
  if (!name) return undefined;
  const details = joinList([
    textField(gua, 'palace') ? `${textField(gua, 'palace')}宫` : undefined,
    textField(gua, 'palaceWuXing')
      ? `五行${textField(gua, 'palaceWuXing')}`
      : undefined,
    textField(gua, 'palaceLevel'),
    textField(gua, 'shenYao') ? `身爻${textField(gua, 'shenYao')}` : undefined,
  ]);
  return details ? `${label}：${name}（${details}）` : `${label}：${name}`;
}

function formatYaoLine(
  yao: Record<string, unknown>,
  zhiYao: Record<string, unknown> | undefined,
): string | undefined {
  const position = Number(yao.position);
  if (!Number.isFinite(position)) return undefined;
  const parts = joinList([
    yao.isMoving === true ? '动爻' : '静爻',
    formatShiYing(yao),
    textField(yao, 'liuShou') ? `六兽 ${textField(yao, 'liuShou')}` : undefined,
    textField(yao, 'liuQin') ? `六亲 ${textField(yao, 'liuQin')}` : undefined,
    textField(yao, 'naJia') ? `纳甲 ${textField(yao, 'naJia')}` : undefined,
    textField(yao, 'naYin') ? `纳音 ${textField(yao, 'naYin')}` : undefined,
    textField(yao, 'xingXiu')
      ? `星宿 ${textField(yao, 'xingXiu')}`
      : undefined,
    textField(yao, 'suoBo') ? `锁泊 ${textField(yao, 'suoBo')}` : undefined,
    formatSuiXian(yao),
    zhiYao && yao.isMoving === true ? formatChangedYao(zhiYao) : undefined,
    zhiYao && yao.isMoving === true
      ? formatBackRelation(yao, zhiYao)
      : undefined,
  ]);
  return `${YAO_LABELS[position] ?? `${position}爻`}：${parts}`;
}

function formatShiYing(yao: Record<string, unknown>): string | undefined {
  const mark = textField(yao, 'shiYing');
  if (!mark) return undefined;
  return mark === '應' ? '应' : mark;
}

function formatChangedYao(yao: Record<string, unknown>): string | undefined {
  const parts = [
    textField(yao, 'naJia') ? `纳甲 ${textField(yao, 'naJia')}` : undefined,
    textField(yao, 'liuQin') ? `六亲 ${textField(yao, 'liuQin')}` : undefined,
    textField(yao, 'naYin') ? `纳音 ${textField(yao, 'naYin')}` : undefined,
    textField(yao, 'xingXiu')
      ? `星宿 ${textField(yao, 'xingXiu')}`
      : undefined,
    textField(yao, 'suoBo') ? `锁泊 ${textField(yao, 'suoBo')}` : undefined,
    formatSuiXian(yao),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? `化 ${parts.join(' ')}` : undefined;
}

/** 五行字面量集合,用于把序列化后的字符串安全收窄为 WuXing 类型。 */
const WU_XING_SET = new Set<WuXing>(['金', '木', '水', '火', '土']);

/** 将任意文本收窄为五行字面量;非五行返回 undefined。 */
function asWuXing(value: string | undefined): WuXing | undefined {
  return value && WU_XING_SET.has(value as WuXing)
    ? (value as WuXing)
    : undefined;
}

/** 从纳甲(干支两字,如 “己亥”)取地支(末字)。 */
function diZhiOf(naJia: string | undefined): string | undefined {
  return naJia && naJia.length >= 2 ? naJia.slice(-1) : undefined;
}

/**
 * 比和(变爻与本爻同五行)时判断化进神 / 化退神,由动爻地支与变爻地支决定。
 *
 * DI_ZHI = [子丑寅卯辰巳午未申酉戌亥] 为固定地支次序,且首尾相接成环
 * (亥之后回到子)。以环形步距 step =(to - from + 12) % 12 判定:
 *   - step === 1  本爻 → 变爻 顺行相邻 → 化进神
 *   - step === 11 本爻 → 变爻 逆行相邻 → 化退神
 * 标准四组寅卯(木)、巳午(火)、申酉(金)、亥子(水)均落入相邻;
 * 其中亥(11)→子(0)为环形顺行=进神、子→亥为环形逆行=退神。
 * 土爻辰戌丑未在序中彼此隔 3 位、step 非 1/11,默认不计进退(见下方 TODO)。
 *
 * @param benZhi     动爻(本爻)地支,如 “寅”
 * @param changedZhi 变爻地支,如 “卯”
 * @returns '化进神' | '化退神' | undefined(不构成进退神)
 */
function describeJinTuiShen(
  benZhi: string,
  changedZhi: string,
): string | undefined {
  const from = DI_ZHI.findIndex((zhi) => zhi === benZhi);
  const to = DI_ZHI.findIndex((zhi) => zhi === changedZhi);
  if (from < 0 || to < 0) return undefined;
  const step = (to - from + 12) % 12;
  if (step === 1) return '化进神';
  if (step === 11) return '化退神';
  // TODO(可选,由卦师/流派决定):土爻辰戌丑未隔位,如需纳入进退神在此补充规则。
  return undefined;
}

/**
 * 把“变爻相对本爻(动爻)”的五行关系翻译成断卦标记词。
 *
 * getWuXingRelation(yaoWx, gongWx) 以第二个参数(此处=本爻)为“我”的视角描述
 * 第一个参数(此处=变爻),因此:
 *   - '尅我' = 变爻克本爻 → 回头克(动爻反受其制,多主成事不成、得而复失)
 *   - '生我' = 变爻生本爻 → 回头生(动爻得变爻回头扶助)
 *   - '比和' = 同五行 → 转交 describeJinTuiShen 判进神/退神
 *   - '我生'(泄气)/'我尅'(化出)默认不单独标注
 *
 * 返回 undefined 表示该关系暂不标注。
 */
function describeBackRelation(
  relation: WuXingRelation,
  benZhi: string | undefined,
  changedZhi: string | undefined,
): string | undefined {
  switch (relation) {
    case '尅我':
      return '回头克';
    case '生我':
      return '回头生';
    case '比和':
      return benZhi && changedZhi
        ? describeJinTuiShen(benZhi, changedZhi)
        : undefined;
    // TODO: 是否补标 '我生'(泄气)/'我尅'(化出)由卦师决定
    default:
      return undefined;
  }
}

/**
 * 计算并格式化动爻与其变爻之间的回头生克 / 进退神标记。
 * 仅在本爻、变爻五行齐备时返回标记,缺失时返回 undefined。
 */
function formatBackRelation(
  benYao: Record<string, unknown>,
  zhiYao: Record<string, unknown>,
): string | undefined {
  const benWuXing = asWuXing(textField(benYao, 'wuXing'));
  const changedWuXing = asWuXing(textField(zhiYao, 'wuXing'));
  if (!benWuXing || !changedWuXing) return undefined;
  // 以本爻为“我”,描述变爻对本爻的生克;比和时再按地支定进退神
  const relation = getWuXingRelation(changedWuXing, benWuXing);
  const mark = describeBackRelation(
    relation,
    diZhiOf(textField(benYao, 'naJia')),
    diZhiOf(textField(zhiYao, 'naJia')),
  );
  return mark ? `〔${mark}〕` : undefined;
}

function formatSuiXian(yao: Record<string, unknown>): string | undefined {
  const suiXian = recordField(yao, 'suiXian');
  if (!suiXian) return undefined;
  const startAge = textField(suiXian, 'startAge');
  const endAge = textField(suiXian, 'endAge');
  if (!startAge || !endAge) return undefined;
  return `岁限 ${startAge}-${endAge}`;
}

function formatXunKong(root: Record<string, unknown>): string | undefined {
  const text = joinList([
    textField(root, 'yearKong')
      ? `年空${textField(root, 'yearKong')}`
      : undefined,
    textField(root, 'monthKong')
      ? `月空${textField(root, 'monthKong')}`
      : undefined,
    textField(root, 'dayKong') ? `日空${textField(root, 'dayKong')}` : undefined,
  ]);
  return text ? `旬空：${text}` : undefined;
}

function formatYaoTable(root: Record<string, unknown>): string[] {
  const benGua = recordField(root, 'benGua');
  const zhiGua = recordField(root, 'zhiGua');
  if (!benGua) return [];
  const zhiByPosition = new Map<number, Record<string, unknown>>();
  if (zhiGua) {
    for (const yao of arrayField(zhiGua, 'yaoList')) {
      const record = asRecord(yao);
      const position = Number(record?.position);
      if (record && Number.isFinite(position))
        zhiByPosition.set(position, record);
    }
  }
  return arrayField(benGua, 'yaoList')
    .map(asRecord)
    .filter((yao): yao is Record<string, unknown> => Boolean(yao))
    .sort((a, b) => Number(b.position) - Number(a.position))
    .map((yao) => formatYaoLine(yao, zhiByPosition.get(Number(yao.position))))
    .filter((line): line is string => Boolean(line));
}

function formatFuShen(value: unknown): string | undefined {
  const fu = asRecord(value);
  if (!fu) return undefined;
  const hostPosition = Number(fu.hostPosition);
  const hostLabel = Number.isFinite(hostPosition)
    ? YAO_LABELS[hostPosition] || `${hostPosition}爻`
    : undefined;
  const parts = joinList([
    textField(fu, 'fuLiuQin')
      ? `六亲 ${textField(fu, 'fuLiuQin')}`
      : undefined,
    textField(fu, 'fuNaJia') ? `纳甲 ${textField(fu, 'fuNaJia')}` : undefined,
    textField(fu, 'fuNaYin') ? `纳音 ${textField(fu, 'fuNaYin')}` : undefined,
    hostLabel ? `伏于${hostLabel}` : undefined,
  ]);
  return parts || undefined;
}

function formatFuShenTable(value: unknown): string[] {
  return arrayField(asRecord(value) ?? {}, 'fuShen')
    .map(asRecord)
    .filter((fu): fu is Record<string, unknown> => Boolean(fu))
    .sort((a, b) => Number(b.hostPosition) - Number(a.hostPosition))
    .map(formatFuShen)
    .filter((line): line is string => Boolean(line));
}

function formatPangFuShenTable(value: unknown): string[] {
  return arrayField(asRecord(value) ?? {}, 'pangFuShen')
    .map(asRecord)
    .filter((fu): fu is Record<string, unknown> => Boolean(fu))
    .sort((a, b) => Number(b.hostPosition) - Number(a.hostPosition))
    .map(formatFuShen)
    .filter((line): line is string => Boolean(line));
}

function formatShenShaPairs(record: unknown): string[] {
  const shenSha = asRecord(record);
  if (!shenSha) return [];
  return Object.entries(shenSha).flatMap(([key, value]) => {
    const values = scalarArray(value);
    if (values.length > 0) return [`${key}:${values.join('、')}`];
    const text = scalarText(value);
    return text ? [`${key}:${text}`] : [];
  });
}

/** 六爻 formatter：按起卦、卦象、六爻、伏神和神煞重排结果。 */
export const formatIchingPaipan: PaipanFormatter = (artifactData) => {
  const root = asRecord(artifactData);
  if (!root || !recordField(root, 'benGua'))
    return formatGenericPaipan(artifactData);

  const benGua = recordField(root, 'benGua');
  const moves = movingPositions(benGua);
  const lines: string[] = [];

  pushSection(lines, '起卦概要', [
    formatQueryTime(recordField(root, 'queryTime'))
      ? `起卦时间：${formatQueryTime(recordField(root, 'queryTime'))}`
      : undefined,
    formatGanZhi(root) ? `四柱：${formatGanZhi(root)}` : undefined,
    formatXunKong(root),
    textField(root, 'monthJian')
      ? `月建：${textField(root, 'monthJian')}`
      : undefined,
    textField(root, 'yaoString')
      ? `爻码：${textField(root, 'yaoString')}`
      : undefined,
    moves.length > 0
      ? `动爻：${moves.map((position) => YAO_LABELS[position] ?? `${position}爻`).join('、')}`
      : '动爻：无',
  ]);

  pushSection(lines, '卦象关系', [
    formatGuaSummary('本卦', benGua),
    formatGuaSummary('变卦', recordField(root, 'zhiGua')),
    formatGuaSummary('互卦', recordField(root, 'huGua')),
  ]);
  pushSection(lines, '本卦六爻（上爻在前）', formatYaoTable(root));
  pushSection(lines, '伏神', formatFuShenTable(benGua));
  pushSection(lines, '旁宫伏神', formatPangFuShenTable(benGua));
  pushSection(lines, '神煞', formatShenShaPairs(recordField(root, 'shenSha')));

  return lines.join('\n').trim();
};
