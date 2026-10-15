/**
 * 技能与创作者域跨端契约(运行时常量 + 类型)。
 */

import type { OkResponse } from '../common/api.js';

/** 用户可创建的自定义 Skill 数量上限。 */
export const MAX_USER_SKILLS = 30;

/** 单个 Skill Bundle 允许包含的最大文本文件数。 */
export const MAX_SKILL_BUNDLE_FILES = 50;

/** 单个 Skill Bundle 文件允许包含的最大字符数。 */
export const MAX_SKILL_BUNDLE_FILE_LENGTH = 100_000;

/** 单个 Skill Bundle 所有文件合计允许包含的最大字符数。 */
export const MAX_SKILL_BUNDLE_TOTAL_LENGTH = 500_000;

/** ZIP 导入文件允许的最大字节数。 */
export const MAX_SKILL_BUNDLE_ZIP_BYTES = 8 * 1024 * 1024;

/**
 * 受控技能分类白名单（按广义用途/场景维度）。
 *
 * @remarks
 * Skill 不局限于术数——平台上也有角色扮演、分析、写作等用途，故顶层分类按「拿来做什么」
 * 划分用途桶，「术数」只是其中一个桶。术数桶之下细分的术数门类见
 * category-aliases.json，目前仅作为自动归类的判定依据，不作为顶层分类暴露。
 * 末位 '通用' 为兜底默认。
 * 此常量是前后端的**唯一事实源**：API 写入校验与 web 端分类下拉/筛选均引用它，
 * 增删用途桶只改这一处，无需改 DB 约束。顺序即 UI 展示顺序。
 */
export const SKILL_CATEGORIES = [
  '术数',
  '角色扮演',
  '分析',
  '写作',
  '效率工具',
  '学习',
  '娱乐',
  '通用',
] as const;

/** 技能分类取值类型。 */
export type SkillCategoryDto = (typeof SKILL_CATEGORIES)[number];

/** 自动归类未命中时的兜底分类。 */
export const DEFAULT_SKILL_CATEGORY: SkillCategoryDto = '通用';

/** 自动归类命中术数关键词时归入的用途桶（见后端 deriveSkillCategory）。 */
export const DIVINATION_SKILL_CATEGORY: SkillCategoryDto = '术数';

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

export interface UserCustomSkillDto {
  id: string;
  user_id: string;
  skill_name: string;
  dir_name: string;
  description: string;
  /** 受控用途分类，取值见 {@link SKILL_CATEGORIES}，默认 '通用'。 */
  category: string;
  version: string;
  bundle_uri: string;
  checksum: string | null;
  revision_id: string | null;
  format_version: number | null;
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
  own: UserCustomSkillSummaryDto[];
  subscribed: SubscribedSkillSummaryDto[];
}

export type UserCustomSkillSummaryDto = Omit<UserCustomSkillDto, 'files'>;
export type SubscribedSkillSummaryDto = Omit<SubscribedSkillDto, 'files'>;

export type SkillContentImportStatusDto =
  | 'pending'
  | 'missing'
  | 'mismatched'
  | 'invalid'
  | 'complete';

export interface AdminSkillStorageDto {
  state: 'stored' | 'pending' | 'missing' | 'mismatched' | 'invalid';
  current_revision_id: string | null;
  revision_created_at: string | null;
  format_version: number | null;
  revision_count: number;
  file_count: number;
  import_status: SkillContentImportStatusDto | null;
  import_error_code: string | null;
  import_checked_at: string | null;
}

export interface AdminSkillRevisionDto {
  id: string;
  created_at: string;
  format_version: number;
  checksum: string;
  file_count: number;
  content_length: number;
}

export interface AdminCustomSkillSummaryDto {
  id: string;
  user_id: string;
  phone: string | null;
  skill_name: string;
  description: string;
  bundle_uri: string;
  checksum: string | null;
  install_status: UserCustomSkillDto['install_status'];
  content_length: number;
  visibility: UserCustomSkillDto['visibility'];
  share_token: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  storage: AdminSkillStorageDto;
}

export interface AdminCustomSkillDto extends AdminCustomSkillSummaryDto {
  files: TextSkillBundleFileDto[];
  revisions: AdminSkillRevisionDto[];
}

export interface SharedSkillPreviewDto {
  id: string;
  skill_name: string;
  description: string;
  content_length: number;
  author_label: string;
}

/**
 * 单个公开 Skill 详情。
 *
 * @remarks 公开 toC 互动(赞踩/评论)已下线,详情现等价于安装预览。
 */
export interface SharedSkillDetailDto extends SharedSkillPreviewDto {}

/** 管理后台评论审核状态。 */
export type AdminSkillCommentStatusDto = 'pending' | 'approved' | 'rejected';

/** 管理后台查看的 Skill 评论。 */
export interface AdminSkillCommentDto {
  id: string;
  skill_id: string;
  skill_name: string;
  user_id: string;
  user_phone: string | null;
  body: string;
  status: AdminSkillCommentStatusDto;
  pinned: boolean;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 管理后台 Skill 评论列表。 */
export interface AdminSkillCommentsResponseDto {
  items: AdminSkillCommentDto[];
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
  /** 受控用途分类，取值见 {@link SKILL_CATEGORIES}，默认 '通用'，供市场按类筛选。 */
  category: string;
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
