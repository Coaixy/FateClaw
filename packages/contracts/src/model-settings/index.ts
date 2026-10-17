/** The platform owns model configuration for every client. */

export { modelPoolCooldown, type ModelPoolCooldown } from './cooldown.js';
export {
  classifyModelFailure,
  formatModelFailure,
  readModelFailure,
  type ModelFailure,
  type ModelFailureKind,
} from './failure.js';

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
}

export const DEFAULT_BENEFIT_POLICY: BenefitPolicyDto = {
  daily_turns: 3,
  concurrency_limit: 2,
};

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
}
