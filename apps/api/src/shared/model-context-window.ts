import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

interface ModelContextWindowRule {
  prefixes: string[];
  tokens: number;
  containsAll?: string[];
}

const DEFAULT_CONTEXT_WINDOW = 128_000;
export const MIN_CONFIGURED_CONTEXT_WINDOW_TOKENS = 8_192;
export const MAX_CONFIGURED_CONTEXT_WINDOW_TOKENS = 2_000_000;
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const RULES_PATH_CANDIDATES = [
  path.resolve(MODULE_DIR, 'model-context-windows.json'),
  path.resolve(
    MODULE_DIR,
    '../../../../packages/backend-shared/assets/model-context-windows.json',
  ),
];
const RULES_PATH =
  RULES_PATH_CANDIDATES.find((candidate) => fs.existsSync(candidate)) ??
  RULES_PATH_CANDIDATES[0];

let rulesCache: ModelContextWindowRule[] | null = null;

function loadRules(): ModelContextWindowRule[] {
  if (rulesCache) return rulesCache;
  rulesCache = JSON.parse(
    fs.readFileSync(RULES_PATH, 'utf-8'),
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

export function getContextWindow(model: string): number {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return DEFAULT_CONTEXT_WINDOW;

  const matched = loadRules().find((rule) => matchesRule(normalized, rule));
  return matched?.tokens ?? DEFAULT_CONTEXT_WINDOW;
}

export function normalizeConfiguredContextWindowTokens(
  value: unknown,
  label: string,
): number | null {
  // 管理端和用户自配模型都用 0/null 表示“按内置模型表自动识别”。
  if (value === undefined || value === null || value === 0) return null;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < MIN_CONFIGURED_CONTEXT_WINDOW_TOKENS ||
    value > MAX_CONFIGURED_CONTEXT_WINDOW_TOKENS
  ) {
    throw new Error(
      `${label} 的 context_window_tokens 必须是 ${MIN_CONFIGURED_CONTEXT_WINDOW_TOKENS}-${MAX_CONFIGURED_CONTEXT_WINDOW_TOKENS} 的整数`,
    );
  }
  return value;
}

export function resolveContextWindow(args: {
  model: string;
  configured?: number | null;
}): number {
  return args.configured ?? getContextWindow(args.model);
}
