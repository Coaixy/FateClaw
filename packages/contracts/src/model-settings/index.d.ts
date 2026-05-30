/**
 * 模型设置跨端契约。
 */

export type ModelPiApiDto =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai';

export type ModelAuthModeDto =
  | 'openai_api_key'
  | 'anthropic_api_key'
  | 'claude_code_oauth_token'
  | 'gemini_api_key';

export type UserModelSelectionSourceDto = 'custom' | 'official';

export interface OfficialModelDto {
  id: string;
  model_key: string;
  pi_api: ModelPiApiDto;
  display_name: string;
  description: string;
  enabled: boolean;
  priority: number;
  base_url: string | null;
  model_name: string;
  context_window_tokens: number | null;
  input_token_price_per_million_coins: number;
  output_token_price_per_million_coins: number;
  has_secret: boolean;
  auth_mode: ModelAuthModeDto;
}

export interface UserCustomModelConfigDto {
  user_id: string;
  pi_api: ModelPiApiDto;
  base_url: string | null;
  model_name: string;
  context_window_tokens: number | null;
  has_secret: boolean;
  auth_mode: ModelAuthModeDto;
  created_at: string;
  updated_at: string;
}

export interface UserModelSelectionDto {
  user_id: string;
  source: UserModelSelectionSourceDto;
  official_model_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ModelSettingsOverviewDto {
  custom: UserCustomModelConfigDto | null;
  selection: UserModelSelectionDto | null;
  official_models: OfficialModelDto[];
  custom_model_platform_price_per_million_coins: number;
}
