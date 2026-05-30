import type { AdminModelPiApi } from '@/lib/admin-api';

/**
 * 后台官方模型表单的临时草稿。
 */
export type ProviderDraft = {
  model_key: string;
  pi_api: AdminModelPiApi;
  display_name: string;
  description: string;
  enabled: boolean;
  priority: number;
  base_url: string;
  model_name: string;
  context_window_tokens: number;
  input_token_price_per_million_coins: number;
  output_token_price_per_million_coins: number;
};

/**
 * 创建一个空白官方模型草稿。
 */
export function createEmptyDraft(): ProviderDraft {
  return {
    model_key: '',
    pi_api: 'openai-completions',
    display_name: '',
    description: '',
    enabled: true,
    priority: 0,
    base_url: '',
    model_name: '',
    context_window_tokens: 0,
    input_token_price_per_million_coins: 0,
    output_token_price_per_million_coins: 0,
  };
}

function slugifyKeyPart(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'provider';
}

function trimProviderKey(value: string): string {
  return value.slice(0, 80).replace(/-+$/g, '') || 'provider';
}

/**
 * 根据草稿内容生成默认模型标识。
 */
export function buildSuggestedProviderKey(draft: ProviderDraft): string {
  const displayNamePart = slugifyKeyPart(draft.display_name);
  const modelNamePart = slugifyKeyPart(draft.model_name);
  const keyPart =
    displayNamePart === 'provider' && modelNamePart !== 'provider'
      ? modelNamePart
      : displayNamePart;
  return trimProviderKey(`${draft.pi_api}-${keyPart}`);
}

/**
 * 生成不会和现有模型标识冲突的默认模型标识。
 */
export function buildUniqueSuggestedProviderKey(
  draft: ProviderDraft,
  existingKeys: string[],
): string {
  const existing = new Set(existingKeys.map((key) => key.toLowerCase()));
  const base = buildSuggestedProviderKey(draft);
  if (!existing.has(base.toLowerCase())) {
    return base;
  }

  for (let index = 2; index < 1000; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${base.slice(0, 80 - suffix.length)}${suffix}`;
    if (!existing.has(candidate.toLowerCase())) {
      return candidate;
    }
  }

  const fallback = Date.now().toString(36);
  return `${base.slice(0, 79 - fallback.length)}-${fallback}`;
}

/**
 * 更新启停状态时保留其他未保存字段。
 */
export function setProviderDraftEnabled(
  draft: ProviderDraft,
  enabled: boolean,
): ProviderDraft {
  return {
    ...draft,
    enabled,
  };
}
