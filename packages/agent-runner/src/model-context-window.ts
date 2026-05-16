import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

interface ModelContextWindowRule {
  prefixes: string[];
  tokens: number;
  containsAll?: string[];
}

const DEFAULT_CONTEXT_WINDOW = 128_000;
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(MODULE_DIR, '..');
const RULES_PATH_CANDIDATES = [
  path.resolve(PACKAGE_DIR, 'dist/shared/model-context-windows.json'),
  path.resolve(PACKAGE_DIR, '../../apps/api/src/shared/model-context-windows.json'),
];

let rulesCache: ModelContextWindowRule[] | null = null;

function resolveRulesPath(): string {
  for (const candidate of RULES_PATH_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `未找到 model-context-windows.json，可检查以下路径：${RULES_PATH_CANDIDATES.join(', ')}`,
  );
}

function loadRules(): ModelContextWindowRule[] {
  if (rulesCache) return rulesCache;
  rulesCache = JSON.parse(
    fs.readFileSync(resolveRulesPath(), 'utf-8'),
  ) as ModelContextWindowRule[];
  return rulesCache;
}

function matchesRule(model: string, rule: ModelContextWindowRule): boolean {
  if (!rule.prefixes.some((prefix) => model.startsWith(prefix.toLowerCase()))) {
    return false;
  }
  return (rule.containsAll ?? []).every((needle) =>
    model.includes(needle.toLowerCase()),
  );
}

export function getContextWindowForModel(model: string): number {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return DEFAULT_CONTEXT_WINDOW;

  const matched = loadRules().find((rule) => matchesRule(normalized, rule));
  return matched?.tokens ?? DEFAULT_CONTEXT_WINDOW;
}
