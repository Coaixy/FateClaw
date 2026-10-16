/** The platform owns model configuration for every client. */

export type ModelPoolKey = 'official' | 'benefit';
export type BenefitSupplyState =
  | 'available'
  | 'busy'
  | 'exhausted'
  | 'disabled'
  | 'unknown';

export interface BenefitPolicyDto {
  daily_turns: number;
  concurrency_limit: number;
  queue_limit: number;
  queue_timeout_seconds: number;
  execution_timeout_seconds: number;
  max_model_calls: number;
  max_tool_calls: number;
  max_input_tokens: number;
  max_total_input_tokens: number;
  max_output_tokens: number;
  max_total_output_tokens: number;
}

export const DEFAULT_BENEFIT_POLICY: BenefitPolicyDto = {
  daily_turns: 3,
  concurrency_limit: 2,
  queue_limit: 20,
  queue_timeout_seconds: 30,
  execution_timeout_seconds: 180,
  max_model_calls: 4,
  max_tool_calls: 4,
  max_input_tokens: 16_384,
  max_total_input_tokens: 65_536,
  max_output_tokens: 2_048,
  max_total_output_tokens: 4_096,
};

export interface BenefitQuotaGroupDto {
  id: string;
  display_name: string;
  requests_per_minute: number;
  requests_per_day: number;
  tokens_per_minute: number;
  tokens_per_day: number;
  reset_timezone: string;
  expires_at: string | null;
  approved: boolean;
  used_requests_today?: number;
  reserved_tokens_today?: number;
  cooldown_until?: string | null;
}

export interface BenefitModelOverviewDto {
  model: OfficialModelDto | null;
  enabled: boolean;
  supply: BenefitSupplyState;
  daily_turns: number;
  remaining_turns: number | null;
  resets_at: string;
}

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

export interface AdminModelPoolNodeDto {
  id: string;
  is_primary: boolean;
  display_name: string;
  model_name: string;
  pi_api: ModelPiApiDto;
  base_url: string | null;
  auth_mode: ModelAuthModeDto;
  context_window_tokens: number | null;
  enabled: boolean;
  weight: number;
  has_secret: boolean;
  failure_count: number;
  cooldown_until: string | null;
  updated_at: string;
  quota_group_id?: string | null;
}

export interface ModelSettingsOverviewDto {
  model: OfficialModelDto | null;
  benefit?: BenefitModelOverviewDto;
  preferred_pool?: ModelPoolKey;
}

export interface AdminModelSettingsOverviewDto {
  model: OfficialModelDto;
  thinking_level: ModelThinkingLevelDto;
  nodes: AdminModelPoolNodeDto[];
  revision?: number;
  enabled?: boolean;
  benefit_policy?: BenefitPolicyDto;
  quota_groups?: BenefitQuotaGroupDto[];
}

export interface AdminModelPoolNodeUpdateDto {
  id?: string;
  display_name: string;
  pi_api: ModelPiApiDto;
  base_url: string | null;
  model_name: string;
  api_key?: string;
  auth_mode?: ModelAuthModeDto;
  context_window_tokens: number | null;
  enabled: boolean;
  weight: number;
  quota_group_id?: string | null;
}

export interface AdminModelSettingsUpdateDto {
  display_name: string;
  thinking_level: ModelThinkingLevelDto;
  input_token_price_per_million_coins: number;
  output_token_price_per_million_coins: number;
  nodes: AdminModelPoolNodeUpdateDto[];
  revision?: number;
  enabled?: boolean;
  benefit_policy?: BenefitPolicyDto;
  quota_groups?: BenefitQuotaGroupDto[];
}

/** Request-only connection snapshot. Credentials must be omitted from durable state. */
export interface RuntimeModelPoolNode {
  modelConfigId: string;
  revision: number;
  weight: number;
  piApi: ModelPiApiDto;
  model: string;
  providerKey: string;
  authMode: ModelAuthModeDto;
  apiKey: string;
  baseUrl?: string;
  poolKey?: ModelPoolKey;
  quotaGroupId?: string;
}
