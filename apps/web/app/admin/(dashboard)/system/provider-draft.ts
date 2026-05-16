import type { AdminModelProviderType } from '@/lib/admin-api';

export type AuthMode =
  | 'openai_api_key'
  | 'anthropic_api_key'
  | 'claude_code_oauth_token'
  | 'gemini_api_key';

export type ProviderDraft = {
  model_key: string;
  protocol: AdminModelProviderType;
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
    protocol: 'openai-compatible',
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
  return `${draft.protocol}-${slugifyKeyPart(draft.display_name)}`;
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
