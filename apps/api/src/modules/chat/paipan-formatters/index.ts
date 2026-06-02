import { formatBaziPaipan } from './bazi.js';
import { formatGenericPaipan } from './fallback.js';
import { formatIchingPaipan } from './iching.js';
import { formatJingzhanPaipan } from './jingzhan.js';
import { formatLiurenPaipan } from './liuren.js';
import { formatQimenPaipan } from './qimen.js';
import type { PaipanFormatter } from './types.js';
import { formatZiweiPaipan } from './ziwei.js';

export { formatGenericPaipan };
export type { PaipanFormatter };

const OFFICIAL_PAIPAN_TITLES: Record<string, string> = {
  'bazi-paipan': '八字排盘',
  'iching-paipan': '六爻排盘',
  'jingzhan-paipan': '经占排盘',
  'liuren-paipan': '大六壬排盘',
  'qimen-paipan': '奇门遁甲排盘',
  'ziwei-paipan': '紫微斗数排盘',
};

const OFFICIAL_PAIPAN_FORMATTERS: Record<string, PaipanFormatter> = {
  'bazi-paipan': formatBaziPaipan,
  'iching-paipan': formatIchingPaipan,
  'jingzhan-paipan': formatJingzhanPaipan,
  'liuren-paipan': formatLiurenPaipan,
  'qimen-paipan': formatQimenPaipan,
  'ziwei-paipan': formatZiweiPaipan,
};

/** 根据系统排盘 skill 名称选择专用 formatter，并保留通用兜底。 */
export function formatOfficialPaipan(
  skill: string,
  artifactData: unknown,
): string {
  if (artifactData === undefined) return '';
  const title = OFFICIAL_PAIPAN_TITLES[skill] ?? skill;
  const formatter = OFFICIAL_PAIPAN_FORMATTERS[skill] ?? formatGenericPaipan;
  const body = formatter(artifactData).trim();
  return [`${title}（系统排盘结果）`, body].filter(Boolean).join('\n').trim();
}
