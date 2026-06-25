/**
 * 关键词 → 标准类别映射表，用于从用户消息中归一化术数类别。
 * 词典来源：packages/backend-shared/assets/category-aliases.json（后端运行时共用同一份源数据）。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  DEFAULT_SKILL_CATEGORY,
  DIVINATION_SKILL_CATEGORY,
} from '@fateclaw/contracts/skills';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CATEGORY_ALIASES_PATH_CANDIDATES = [
  path.resolve(MODULE_DIR, '../../shared/category-aliases.json'),
  path.resolve(
    MODULE_DIR,
    '../../../../../packages/backend-shared/assets/category-aliases.json',
  ),
];
const CATEGORY_ALIASES_PATH =
  CATEGORY_ALIASES_PATH_CANDIDATES.find((candidate) =>
    fs.existsSync(candidate),
  ) ?? CATEGORY_ALIASES_PATH_CANDIDATES[0];
const KEYWORD_TO_CATEGORY: Record<string, string> = JSON.parse(
  fs.readFileSync(CATEGORY_ALIASES_PATH, 'utf-8'),
);

/**
 * 从文本中提取标准类别。返回第一个命中的类别，或 null。
 * 优先匹配更长的关键词以避免歧义。
 */
export function normalizeCategory(text: string): string | null {
  const sorted = Object.entries(KEYWORD_TO_CATEGORY).sort(
    (a, b) => b[0].length - a[0].length,
  );
  for (const [keyword, category] of sorted) {
    if (text.includes(keyword)) {
      return category;
    }
  }
  return null;
}

/**
 * 为新建/导入的技能推断广义用途分类（「自动归类」策略的核心）。
 *
 * @remarks
 * 顶层分类是广义用途桶（术数/角色扮演/分析/写作…），而关键词词表只覆盖术数。
 * 因此自动归类只能可靠识别「术数」一类：把「技能名 + 描述」喂给 normalizeCategory，
 * 命中任一术数关键词即归入 {@link DIVINATION_SKILL_CATEGORY}（术数）桶；其余用途
 * （角色扮演/分析/写作…）关键词难以可靠判定，统一落到兜底 '通用'，交由作者手选覆盖。
 *
 * 可调的决策接缝是喂给 normalizeCategory 的文本范围（仅 name？name+description？
 * 再叠加 SKILL.md 正文？）——范围越大召回越高，但也更易被正文里偶然出现的术语误判。
 * 当前用 name+description，与 0064 迁移的存量回填口径一致。
 *
 * @param name 技能展示名（frontmatter name，回退到用户输入名）
 * @param description 技能描述（frontmatter description）
 * @returns 命中术数关键词时返回 '术数'，否则返回兜底 '通用'
 */
export function deriveSkillCategory(name: string, description: string): string {
  return normalizeCategory(`${name} ${description}`)
    ? DIVINATION_SKILL_CATEGORY
    : DEFAULT_SKILL_CATEGORY;
}

/**
 * 从文本中提取所有命中的标准类别关键词。
 */
export function extractCategoryKeywords(text: string): string[] {
  const matched: string[] = [];
  for (const keyword of Object.keys(KEYWORD_TO_CATEGORY)) {
    if (text.includes(keyword)) {
      matched.push(keyword);
    }
  }
  return matched;
}
