/**
 * 关键词 → 标准类别映射表，用于从用户消息中归一化术数类别。
 * 词典来源：packages/backend-shared/assets/category-aliases.json（后端运行时共用同一份源数据）。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
