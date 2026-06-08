/**
 * 技能与创作者域跨端契约。
 */

import type { OkResponse } from '../common/api.js';

/** 用户可创建的自定义 Skill 数量上限。 */
export declare const MAX_USER_SKILLS: 30;

/** 单个 Skill Bundle 允许包含的最大文本文件数。 */
export declare const MAX_SKILL_BUNDLE_FILES: 50;

/** 单个 Skill Bundle 文件允许包含的最大字符数。 */
export declare const MAX_SKILL_BUNDLE_FILE_LENGTH: 100000;

/** 单个 Skill Bundle 所有文件合计允许包含的最大字符数。 */
export declare const MAX_SKILL_BUNDLE_TOTAL_LENGTH: 500000;

/** ZIP 导入文件允许的最大字节数。 */
export declare const MAX_SKILL_BUNDLE_ZIP_BYTES: 8388608;

/** 当前生效的 Skill Bundle 文件限制。 */
export interface SkillBundleLimitsDto {
  max_files: number;
  max_file_chars: number;
  max_total_chars: number;
  max_zip_bytes: number;
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

/** 私密授权链接绑定的目标类型。 */
export type SkillAccessInviteTargetTypeDto = 'skill' | 'bundle';

/** 私密授权链接当前可领取状态。 */
export type SkillAccessInviteStatusDto =
  | 'active'
  | 'expired'
  | 'revoked'
  | 'used_up';

/** 创建私密授权链接的请求。 */
export interface CreateSkillAccessInviteRequestDto {
  target_type: SkillAccessInviteTargetTypeDto;
  target_id: string;
  max_redemptions?: number;
  expires_at?: string | null;
  note?: string;
}

/** 作者侧查看的私密授权链接信息。 */
export interface SkillAccessInviteDto {
  id: string;
  creator_id: string;
  target_type: SkillAccessInviteTargetTypeDto;
  target_id: string;
  token: string;
  max_redemptions: number;
  redeemed_count: number;
  expires_at: string | null;
  revoked_at: string | null;
  note: string;
  created_at: string;
  install_url: string;
  status: SkillAccessInviteStatusDto;
}

/** 领取私密授权前展示的公开预览。 */
export interface SkillAccessInvitePreviewDto {
  token: string;
  target_type: SkillAccessInviteTargetTypeDto;
  status: SkillAccessInviteStatusDto;
  skill: SharedSkillPreviewDto | null;
  bundle: SharedBundlePreviewDto | null;
}

/** 领取私密授权后的订阅结果。 */
export interface SkillAccessInviteRedeemResultDto {
  target_type: SkillAccessInviteTargetTypeDto;
  subscribed_count: number;
  skipped_count: number;
  subscription_ids: string[];
}

export interface MarketSkillDto {
  id: string;
  skill_name: string;
  description: string;
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

export interface SkillDeleteResponseDto extends OkResponse {}
