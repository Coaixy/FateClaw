import type { HistoryMessage } from './types.js';
import { inferCategoryFromUserPastedBoardSkill } from './pasted-board-context.js';

export const CATEGORY_TO_OFFICIAL_SKILL: Record<string, string> = {
  八字: 'bazi-paipan',
  紫微: 'ziwei-paipan',
  周易: 'jingzhan-paipan',
  大衍: 'jingzhan-paipan',
  梅花: 'iching-paipan',
  六爻: 'iching-paipan',
  经占: 'jingzhan-paipan',
  奇门: 'qimen-paipan',
};

const OFFICIAL_SKILL_TO_CATEGORY: Record<string, string> = {
  'bazi-paipan': '八字',
  'ziwei-paipan': '紫微',
  'iching-paipan': '六爻',
  'jingzhan-paipan': '经占',
  'qimen-paipan': '奇门',
};

export function resolveEvidenceCategoryBySkill(skill: string): string | null {
  return (
    OFFICIAL_SKILL_TO_CATEGORY[skill] ||
    inferCategoryFromUserPastedBoardSkill(skill)
  );
}

export function hasHistoricalEvidenceForSkill(
  history: HistoryMessage[],
  skillName: string,
): boolean {
  return history.some((message) =>
    (message.toolContext ?? []).some((ctx) => ctx.skill === skillName),
  );
}
