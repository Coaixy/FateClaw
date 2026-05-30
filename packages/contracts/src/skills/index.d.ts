/**
 * 技能与创作者域跨端契约。
 */

import type { OkResponse } from '../common/api.js';

export interface SkillPriceTierDto {
  key: string;
  label: string;
  price_cents: number;
  duration_days: number | null;
  description?: string;
}

export interface TextSkillBundleFileDto {
  path: string;
  content: string;
}

export interface CreateUserSkillRequestDto {
  skill_name: string;
  dir_name?: string;
  files: TextSkillBundleFileDto[];
}

export interface UpdateUserSkillRequestDto {
  skill_name?: string;
  files?: TextSkillBundleFileDto[];
}

export interface UserCustomSkillDto {
  id: string;
  user_id: string;
  skill_name: string;
  dir_name: string;
  description: string;
  version: string;
  bundle_uri: string;
  checksum: string | null;
  install_status: 'installed' | 'missing' | 'error';
  acl: Record<string, unknown>;
  billing_policy: Record<string, unknown>;
  audit_metadata: Record<string, unknown>;
  files: TextSkillBundleFileDto[];
  content_length: number;
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
  price_tiers: Array<Pick<SkillPriceTierDto, 'key' | 'label' | 'price_cents'>>;
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
  price_cents: number;
  duration_days: number | null;
  description?: string;
}

export interface CreatorBundleConfigResponseDto {
  bundle_tiers: CreatorBundleTierDto[];
  skills: MarketSkillDto[];
}

export interface SkillDeleteResponseDto extends OkResponse {}
