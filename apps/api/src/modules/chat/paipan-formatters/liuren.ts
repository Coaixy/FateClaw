import { formatGenericPaipan } from './fallback.js';
import type { PaipanFormatter } from './types.js';
import {
  arrayField,
  asRecord,
  joinList,
  pushSection,
  recordField,
  recordScalarPairs,
  textField,
} from './utils.js';

const BRANCH_KEYS = [
  'zi',
  'chou',
  'yin',
  'mao',
  'chen',
  'si',
  'wu',
  'wei',
  'shen',
  'you',
  'xu',
  'hai',
] as const;
const BRANCH_LABELS: Record<string, string> = {
  zi: '子',
  chou: '丑',
  yin: '寅',
  mao: '卯',
  chen: '辰',
  si: '巳',
  wu: '午',
  wei: '未',
  shen: '申',
  you: '酉',
  xu: '戌',
  hai: '亥',
};
const BRANCH_KEY_BY_LABEL = Object.fromEntries(
  Object.entries(BRANCH_LABELS).map(([key, label]) => [label, key]),
) as Record<string, (typeof BRANCH_KEYS)[number]>;

interface LiurenFormatterContext {
  tianJiang?: Record<string, unknown>;
  dunGan?: Record<string, unknown>;
}

function branchKeyOf(value?: string): (typeof BRANCH_KEYS)[number] | undefined {
  if (!value) return undefined;
  return BRANCH_KEY_BY_LABEL[value.slice(0, 1)];
}

function branchText(
  record: Record<string, unknown> | undefined,
  branch: string | undefined,
): string | undefined {
  const key = branchKeyOf(branch);
  return key && record ? textField(record, key) : undefined;
}

function formatDunGan(value: string | undefined): string {
  return value && value !== '无' ? value : '空';
}

function splitKePair(value?: string): { upper?: string; lower?: string } {
  const chars = Array.from(value ?? '').filter(Boolean);
  return {
    upper: chars[0],
    lower: chars.slice(1).join('') || undefined,
  };
}

function formatLowerShen(lower: string | undefined): string | undefined {
  if (!lower) return undefined;
  return `下神：${lower}`;
}

function formatKe(
  value: unknown,
  label: string,
  context: LiurenFormatterContext,
): string | undefined {
  const items = arrayField({ value }, 'value').map(String).filter(Boolean);
  if (items.length === 0) return undefined;

  const [pair, dayJiang] = items;
  const { upper, lower } = splitKePair(pair);
  const upperNightJiang = branchText(context.tianJiang, upper);
  const upperDunGan = branchText(context.dunGan, upper);
  const parts = joinList([
    upper ? `上神：${upper}` : pair ? `课体：${pair}` : undefined,
    formatLowerShen(lower),
    dayJiang ? `昼将：${dayJiang}` : undefined,
    upperNightJiang ? `夜将：${upperNightJiang}` : undefined,
    upperDunGan ? `上神遁干：${formatDunGan(upperDunGan)}` : undefined,
  ]);

  return parts ? `${label}：${parts}` : undefined;
}

function formatChuan(
  value: unknown,
  label: string,
  context: LiurenFormatterContext,
): string | undefined {
  const items = arrayField({ value }, 'value').map(String).filter(Boolean);
  if (items.length === 0) return undefined;

  const [branch, dayJiang, relation, dunGan] = items;
  const nightJiang = branchText(context.tianJiang, branch);
  const fallbackDunGan = branchText(context.dunGan, branch);
  const parts = joinList([
    branch ? `传支：${branch}` : undefined,
    relation ? `六亲：${relation}` : undefined,
    `遁干：${formatDunGan(dunGan || fallbackDunGan)}`,
    dayJiang ? `昼将：${dayJiang}` : undefined,
    nightJiang ? `夜将：${nightJiang}` : undefined,
  ]);

  return parts ? `${label}：${parts}` : undefined;
}

function palaceLines(root: Record<string, unknown>): string[] {
  const tianDiPan = recordField(root, 'tianDiPan');
  if (!tianDiPan) return [];
  const tianPan = recordField(tianDiPan, 'tianPan');
  const fallbackNightJiang = recordField(tianDiPan, 'tianJiang');
  const yinYangGuiRen = recordField(root, 'yinYangGuiRen');
  const dayJiang = yinYangGuiRen
    ? recordField(yinYangGuiRen, 'yangGuiRen')
    : undefined;
  const nightJiang = yinYangGuiRen
    ? recordField(yinYangGuiRen, 'yinGuiRen')
    : undefined;
  const dunGan = recordField(root, 'dunGan');
  if (!tianPan) return [];

  return BRANCH_KEYS.map((key) => {
    const dunGanText = dunGan ? textField(dunGan, key) : undefined;
    const nightJiangText =
      (nightJiang ? textField(nightJiang, key) : undefined) ??
      (fallbackNightJiang ? textField(fallbackNightJiang, key) : undefined);
    const parts = joinList([
      dayJiang && textField(dayJiang, key)
        ? `昼将：${textField(dayJiang, key)}`
        : undefined,
      nightJiangText ? `夜将：${nightJiangText}` : undefined,
      textField(tianPan, key) ? `天盘：${textField(tianPan, key)}` : undefined,
      `遁干：${formatDunGan(dunGanText)}`,
    ]);
    return parts ? `${BRANCH_LABELS[key]}宫：${parts}` : undefined;
  }).filter((line): line is string => Boolean(line));
}

function jianChuLines(root: Record<string, unknown>): string[] {
  const jianChu = recordField(root, 'jianChu');
  if (!jianChu) return [];
  const tianDiPan = recordField(root, 'tianDiPan');
  const tianPan = tianDiPan ? recordField(tianDiPan, 'tianPan') : undefined;

  return BRANCH_KEYS.map((key) => {
    const value = textField(jianChu, key);
    if (!value) return undefined;
    return `${textField(tianPan ?? {}, key) ?? BRANCH_LABELS[key]}：${value}`;
  }).filter((line): line is string => Boolean(line));
}

function formatShenSha(root: Record<string, unknown>): string[] {
  return arrayField(root, 'shenSha')
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => {
      const name = textField(item, 'name');
      const value = textField(item, 'value');
      return name && value ? `${name}：${value}` : undefined;
    })
    .filter((line): line is string => Boolean(line));
}

/** 大六壬 formatter：压缩输出起课概要、四课、三传、天地盘、建除和神煞。 */
export const formatLiurenPaipan: PaipanFormatter = (artifactData) => {
  const root = asRecord(artifactData);
  if (!root) return formatGenericPaipan(artifactData);

  const dateInfo = recordField(root, 'dateInfo');
  const input = recordField(root, 'input');
  const siKe = recordField(root, 'siKe');
  const sanChuan = recordField(root, 'sanChuan');
  const tianDiPan = recordField(root, 'tianDiPan');
  const context: LiurenFormatterContext = {
    tianJiang: tianDiPan ? recordField(tianDiPan, 'tianJiang') : undefined,
    dunGan: recordField(root, 'dunGan'),
  };
  if (!dateInfo || !siKe || !sanChuan) {
    return formatGenericPaipan(artifactData);
  }

  const lines: string[] = [];

  pushSection(lines, '起课概要', [
    input?.mode === 'yuejiang'
      ? '起课方式：古籍式（月将、占时、日干支）'
      : undefined,
    input?.mode === 'yuejiang' && textField(input, 'shiChen')
      ? `占时：${textField(input, 'shiChen')}`
      : undefined,
    input?.mode === 'yuejiang' && textField(input, 'yueLing')
      ? `月令：${textField(input, 'yueLing')}`
      : undefined,
    textField(dateInfo, 'date')
      ? `时间：${textField(dateInfo, 'date')}`
      : undefined,
    textField(dateInfo, 'bazi')
      ? `四柱：${textField(dateInfo, 'bazi')}`
      : undefined,
    textField(dateInfo, 'yuejiang')
      ? `月将：${textField(dateInfo, 'yuejiang')}`
      : undefined,
    arrayField(dateInfo, 'kong').length > 0
      ? `旬空：${arrayField(dateInfo, 'kong').join('、')}`
      : undefined,
    recordScalarPairs(recordField(root, 'input')).length > 0
      ? `输入：${recordScalarPairs(recordField(root, 'input')).join('、')}`
      : undefined,
  ]);

  pushSection(lines, '四课', [
    formatKe(siKe.ke1, '一课', context),
    formatKe(siKe.ke2, '二课', context),
    formatKe(siKe.ke3, '三课', context),
    formatKe(siKe.ke4, '四课', context),
  ]);

  pushSection(lines, '三传', [
    textField(sanChuan, 'keTi')
      ? `课体：${textField(sanChuan, 'keTi')}`
      : undefined,
    formatChuan(sanChuan.chuChuan, '初传', context),
    formatChuan(sanChuan.zhongChuan, '中传', context),
    formatChuan(sanChuan.moChuan, '末传', context),
  ]);

  pushSection(lines, '天地盘', palaceLines(root));
  pushSection(lines, '建除', jianChuLines(root));
  pushSection(lines, '神煞', formatShenSha(root));

  return lines.join('\n').trim();
};
