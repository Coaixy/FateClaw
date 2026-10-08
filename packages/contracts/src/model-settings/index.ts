/** The platform owns model configuration for every client. */

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

export type ModelThinkingLevelDto =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh';

export interface OfficialModelDto {
  id: string;
  model_key: string;
  display_name: string;
  description: string;
  model_name: string;
  context_window_tokens: number | null;
  input_token_price_per_million_coins: number;
  output_token_price_per_million_coins: number;
  has_secret: boolean;
}

export interface AdminOfficialModelDto extends OfficialModelDto {
  pi_api: ModelPiApiDto;
  base_url: string | null;
  auth_mode: ModelAuthModeDto;
  updated_at: string;
}

export interface ModelSettingsOverviewDto {
  model: OfficialModelDto | null;
}

export interface AdminModelSettingsOverviewDto {
  model: AdminOfficialModelDto | null;
  thinking_level: ModelThinkingLevelDto;
}

export interface AdminModelSettingsUpdateDto {
  pi_api: ModelPiApiDto;
  base_url: string | null;
  model_name: string;
  api_key?: string;
  auth_mode?: ModelAuthModeDto;
  context_window_tokens: number | null;
  thinking_level: ModelThinkingLevelDto;
  input_token_price_per_million_coins: number;
  output_token_price_per_million_coins: number;
}
