import type { AdminModelPiApi } from '@/lib/admin-api';

export type ProviderDraft = {
  model_key: string;
  pi_api: AdminModelPiApi;
  display_name: string;
  enabled: boolean;
  priority: number;
  base_url: string;
  model_name: string;
  context_window_tokens: number;
  input_token_price_per_million_points: number;
  output_token_price_per_million_points: number;
};

export function createEmptyDraft(): ProviderDraft {
  return {
    model_key: '',
    pi_api: 'openai-completions',
    display_name: '',
    enabled: true,
    priority: 0,
    base_url: '',
    model_name: '',
    context_window_tokens: 0,
    input_token_price_per_million_points: 0,
    output_token_price_per_million_points: 0,
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

export function buildSuggestedProviderKey(draft: ProviderDraft): string {
  return `${draft.pi_api}-${slugifyKeyPart(draft.display_name)}`;
}

export function setProviderDraftEnabled(
  draft: ProviderDraft,
  enabled: boolean,
): ProviderDraft {
  return {
    ...draft,
    enabled,
  };
}
