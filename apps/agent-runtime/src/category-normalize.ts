/**
 * 类别别名 → 标准类别归一化。
 * 词典来源：packages/backend-shared/assets/category-aliases.json（后端运行时共用同一份源数据）。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(MODULE_DIR, '..');
const CATEGORY_ALIASES_PATH_CANDIDATES = [
  path.resolve(PACKAGE_DIR, 'dist/shared/category-aliases.json'),
  path.resolve(
    PACKAGE_DIR,
    '../../packages/backend-shared/assets/category-aliases.json',
  ),
];

let aliasesCache: Record<string, string> | null = null;

function resolveAliasesPath(): string {
  for (const candidate of CATEGORY_ALIASES_PATH_CANDIDATES) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `未找到 category-aliases.json，可检查以下路径：${CATEGORY_ALIASES_PATH_CANDIDATES.join(', ')}`,
  );
}

function loadAliases(): Record<string, string> {
  if (aliasesCache) {
    return aliasesCache;
  }

  aliasesCache = JSON.parse(
    fs.readFileSync(resolveAliasesPath(), 'utf-8'),
  ) as Record<string, string>;

  return aliasesCache;
}

/**
 * 将类别名归一化为标准名。
 * 如果输入存在于词典中则返回对应标准名，否则返回 null。
 */
export function normalizeCategoryName(category: string): string | null {
  if (!category) return null;
  return loadAliases()[category] ?? null;
}
