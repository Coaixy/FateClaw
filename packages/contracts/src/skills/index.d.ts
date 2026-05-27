/**
 * 技能与创作者域跨端契约。
 */

import type { OkResponse } from '../common/api.js';

export interface SkillDto {
  dir?: string;
  name: string;
  description: string;
  trigger: string;
  enabled: boolean;
  globallyEnabled?: boolean;
  defaultEnabled?: boolean;
  official?: boolean;
  userControllable?: boolean;
}

export interface SkillMetaDto {
  dir: string;
  name: string;
  description: string;
  trigger: string;
}

export type SkillUsageModeDto =
  | 'force_injected'
  | 'reference_only';

export interface SkillPriceTierDto {
  key: string;
  label: string;
  price_points: number;
  duration_days: number | null;
  description?: string;
}

export interface UserCustomSkillDto {
  id: string;
  user_id: string;
  skill_name: string;
  dir_name: string;
  description: string;
  trigger_hint: string;
  version: string;
  bundle_uri: string;
  checksum: string | null;
  install_status: 'installed' | 'missing' | 'error';
  acl: Record<string, unknown>;
  billing_policy: Record<string, unknown>;
  audit_metadata: Record<string, unknown>;
  content: string;
  category: string;
  category_normalized: string | null;
  match_keywords: string[];
  match_patterns: string[];
  example_queries: string[];
  priority: number;
  usage_mode: SkillUsageModeDto;
  visibility: 'private' | 'link_shared' | 'shared';
  share_token: string | null;
  enabled: boolean;
  price_tiers: SkillPriceTierDto[];
  stat_subscriber_count: number;
  stat_view_count: number;
  created_at: string;
  updated_at: string;
}

export interface SubscribedSkillDto extends UserCustomSkillDto {
  subscription_id: string;
  subscription_enabled: boolean;
  author_label: string;
  has_direct_source: boolean;
  source_bundles: BundleSubscriptionSourceDto[];
}

export interface BundleSubscriptionSourceDto {
  id: string;
  name: string;
}

export interface UserSkillsResponseDto {
  own: UserCustomSkillDto[];
  subscribed: SubscribedSkillDto[];
}

export interface SharedSkillPreviewDto {
  id: string;
  skill_name: string;
  description: string;
  trigger_hint: string;
  category: string;
  content_length: number;
  price_tiers: SkillPriceTierDto[];
  author_label: string;
}

export interface SkillShareResponseDto {
  share_token: string;
  skill: UserCustomSkillDto;
}

export interface SkillSubscriptionCreateResponseDto {
  id: string;
}

export interface SkillSubscriptionToggleResponseDto {
  enabled: boolean;
}

export interface MarketSkillDto {
  id: string;
  skill_name: string;
  description: string;
  category: string;
  price_tiers: Array<Pick<SkillPriceTierDto, 'key' | 'label' | 'price_points'>>;
  stat_subscriber_count: number;
  share_token: string | null;
  author_label: string;
}

export interface MarketBundleDto {
  id: string;
  name: string;
  description: string;
  skill_count: number;
  bundle_token: string;
  author_label: string;
}

export interface SkillBundleDto {
  id: string;
  user_id: string;
  name: string;
  description: string;
  skill_ids: string[];
  bundle_token: string | null;
  visibility: 'private' | 'link_shared' | 'shared';
  created_at: string;
  updated_at: string;
}

export interface BundleSkillPreviewDto {
  id: string;
  skill_name: string;
  description: string;
  category: string;
  content_length: number;
}

export interface SharedBundlePreviewDto {
  id: string;
  name: string;
  description: string;
  author_label: string;
  skills: BundleSkillPreviewDto[];
}

export interface BundleShareResponseDto {
  bundle_token: string;
  bundle: SkillBundleDto;
}

export interface BundleSubscribeResultDto {
  subscribed_count: number;
  skipped_count: number;
  subscription_ids: string[];
}

export interface BundleUnsubscribeResultDto {
  unsubscribed_count: number;
}

export interface CreatorBundleTierDto {
  key: string;
  label: string;
  price_points: number;
  duration_days: number | null;
  description?: string;
}

export interface CreatorEarningsMonthlyDto {
  creator_id: string;
  year_month: string;
  gross_points: number;
  platform_cut_points: number;
  net_points: number;
  withdrawn_points: number;
}

export interface CreatorWithdrawalDto {
  id: string;
  amount_points: number;
  amount_yuan: string;
  status: 'pending' | 'approved' | 'rejected' | 'paid' | 'cancelled';
  bank_name?: string | null;
  bank_account?: string | null;
  account_name?: string | null;
  id_number_masked?: string | null;
  tax_type?: 'personal' | 'company' | null;
  platform_fee_points?: number;
  tax_amount_yuan?: string;
  net_amount_yuan?: string;
  review_note?: string | null;
  reviewed_at?: string | null;
  paid_at?: string | null;
  created_at: string;
}

export interface WithdrawalBalanceDto {
  earned_points: number;
  pending_withdrawal_points: number;
  withdrawable_points: number;
  withdrawable_yuan: string;
}

export interface WithdrawalRequestResponseDto {
  id: string;
  amount_points: number;
  amount_yuan: string;
  status: string;
  created_at: string;
}

export interface CreatorBundleConfigResponseDto {
  bundle_tiers: CreatorBundleTierDto[];
  skills: MarketSkillDto[];
}

export interface SkillDeleteResponseDto extends OkResponse {}
