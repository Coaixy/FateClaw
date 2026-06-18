import type {
  AdminSkillCommentDto,
  BundleSubscriptionSourceDto,
  MarketBundleDto,
  PendingSkillCommentDto,
  PublicSkillCommentDto,
  MarketSkillDto,
  SharedBundlePreviewDto,
  SharedSkillDetailDto,
  SharedSkillPreviewDto,
  SkillAccessInviteDto,
  SkillAccessInvitePreviewDto,
  SkillAccessInviteRedeemResultDto,
  SkillReactionKindDto,
  SkillReactionSummaryDto,
  SubscribedSkillDto,
  UserCustomSkillDto,
} from '@fateclaw/contracts/skills';

import {
  type AdminSkillCommentRow,
  type PublicSkillComment,
  type PendingSkillComment,
  resolveSkillAccessInviteStatus,
  type RedeemSkillAccessInviteResult,
  type SkillReactionSummary,
  type SkillAccessInvitePreviewResult,
} from '../infrastructure/db.js';
import type {
  SkillAccessInvite,
  SkillBundle,
  UserCustomSkill,
} from '../shared/types.js';

/**
 * 公开分享与订阅场景不再暴露创作者联系方式，只返回统一的安全标识。
 */
const PUBLIC_AUTHOR_LABEL = '匿名作者';

function toUserCustomSkillDto(skill: UserCustomSkill): UserCustomSkillDto {
  return {
    id: skill.id,
    user_id: skill.user_id,
    skill_name: skill.skill_name,
    dir_name: skill.dir_name,
    description: skill.description,
    version: skill.version,
    bundle_uri: skill.bundle_uri,
    checksum: skill.checksum,
    install_status: skill.install_status,
    acl: skill.acl,
    billing_policy: skill.billing_policy,
    audit_metadata: skill.audit_metadata,
    files: skill.files,
    content_length: skill.content_length,
    visibility: skill.visibility,
    share_token: skill.share_token,
    enabled: skill.enabled,
    stat_subscriber_count: skill.stat_subscriber_count,
    stat_view_count: skill.stat_view_count,
    created_at: skill.created_at,
    updated_at: skill.updated_at,
  };
}

export function toSharedSkillPreviewDto(
  skill: UserCustomSkill,
): SharedSkillPreviewDto {
  return {
    id: skill.id,
    skill_name: skill.skill_name,
    description: skill.description,
    content_length: skill.content_length,
    author_label: PUBLIC_AUTHOR_LABEL,
  };
}

/** 转换 Skill 赞踩聚合计数。 */
export function toSkillReactionSummaryDto(
  summary: SkillReactionSummary,
): SkillReactionSummaryDto {
  return {
    like_count: summary.like_count,
    dislike_count: summary.dislike_count,
  };
}

/** 转换公开匿名评论，确保不暴露提交者身份字段。 */
export function toPublicSkillCommentDto(
  comment: PublicSkillComment,
): PublicSkillCommentDto {
  return {
    id: comment.id,
    body: comment.body,
    pinned: comment.pinned,
    created_at: comment.created_at,
  };
}

/** 转换当前用户本人的待审核评论，不暴露给其他访问者。 */
export function toPendingSkillCommentDto(
  comment: PendingSkillComment,
): PendingSkillCommentDto {
  return {
    id: comment.id,
    body: comment.body,
    status: 'pending',
    created_at: comment.created_at,
  };
}

/** 转换公开 Skill 详情，并仅为公开上架 Skill 暴露互动数据。 */
export function toSharedSkillDetailDto(source: {
  skill: UserCustomSkill;
  reactionSummary: SkillReactionSummary;
  myReaction: SkillReactionKindDto | null;
  comments: PublicSkillComment[];
  myPendingComments: PendingSkillComment[];
}): SharedSkillDetailDto {
  const interactionsEnabled = source.skill.visibility === 'shared';
  return {
    ...toSharedSkillPreviewDto(source.skill),
    reaction_summary: interactionsEnabled
      ? toSkillReactionSummaryDto(source.reactionSummary)
      : { like_count: 0, dislike_count: 0 },
    my_reaction: interactionsEnabled ? source.myReaction : null,
    comments: interactionsEnabled
      ? source.comments.map(toPublicSkillCommentDto)
      : [],
    my_pending_comments: interactionsEnabled
      ? source.myPendingComments.map(toPendingSkillCommentDto)
      : [],
    comments_enabled: interactionsEnabled,
    public_interactions_enabled: interactionsEnabled,
  };
}

type SubscribedSkillSource = UserCustomSkill & {
  subscription_id: string;
  subscription_enabled: boolean;
  has_direct_source: boolean;
  source_bundles: BundleSubscriptionSourceDto[];
};

export function toSubscribedSkillDto(
  skill: SubscribedSkillSource,
): SubscribedSkillDto {
  return {
    ...toUserCustomSkillDto(skill),
    subscription_id: skill.subscription_id,
    subscription_enabled: skill.subscription_enabled,
    author_label: PUBLIC_AUTHOR_LABEL,
    has_direct_source: skill.has_direct_source,
    source_bundles: skill.source_bundles,
  };
}

export function toSubscribedSkillDtos(
  skills: SubscribedSkillSource[],
): SubscribedSkillDto[] {
  return skills.map(toSubscribedSkillDto);
}

type SharedBundlePreviewSource = {
  bundle: SkillBundle;
  skills: SharedBundlePreviewDto['skills'];
};

export function toSharedBundlePreviewDto(
  source: SharedBundlePreviewSource,
): SharedBundlePreviewDto {
  return {
    id: source.bundle.id,
    name: source.bundle.name,
    description: source.bundle.description,
    author_label: PUBLIC_AUTHOR_LABEL,
    skills: source.skills,
  };
}

function inviteInstallUrl(invite: SkillAccessInvite): string {
  const path =
    invite.target_type === 'skill'
      ? '/skills/install'
      : '/skills/bundle/install';
  return `${path}?invite=${encodeURIComponent(invite.token)}`;
}

/**
 * 转换作者侧私密授权链接 DTO。
 */
export function toSkillAccessInviteDto(
  invite: SkillAccessInvite,
): SkillAccessInviteDto {
  return {
    id: invite.id,
    creator_id: invite.creator_id,
    target_type: invite.target_type,
    target_id: invite.target_id,
    token: invite.token,
    max_redemptions: invite.max_redemptions,
    redeemed_count: invite.redeemed_count,
    expires_at: invite.expires_at,
    revoked_at: invite.revoked_at,
    note: invite.note,
    created_at: invite.created_at,
    install_url: inviteInstallUrl(invite),
    status: resolveSkillAccessInviteStatus(invite),
  };
}

/**
 * 转换私密授权链接公开预览 DTO。
 */
export function toSkillAccessInvitePreviewDto(
  source: SkillAccessInvitePreviewResult,
): SkillAccessInvitePreviewDto {
  return {
    token: source.invite.token,
    target_type: source.invite.target_type,
    status: source.status,
    skill: source.skill ? toSharedSkillPreviewDto(source.skill) : null,
    bundle: source.bundle ? toSharedBundlePreviewDto(source.bundle) : null,
  };
}

/**
 * 转换私密授权领取结果 DTO。
 */
export function toSkillAccessInviteRedeemResultDto(
  source: RedeemSkillAccessInviteResult,
): SkillAccessInviteRedeemResultDto {
  return {
    target_type: source.targetType ?? 'skill',
    subscribed_count: source.subscribedCount,
    skipped_count: source.skippedCount,
    subscription_ids: source.subscriptionIds,
  };
}

type MarketSkillSource = {
  id: string;
  skill_name: string;
  description: string;
  stat_subscriber_count: number;
  share_token: string | null;
};

export function toMarketSkillDto(skill: MarketSkillSource): MarketSkillDto {
  return {
    id: skill.id,
    skill_name: skill.skill_name,
    description: skill.description,
    stat_subscriber_count: skill.stat_subscriber_count,
    share_token: skill.share_token,
    author_label: PUBLIC_AUTHOR_LABEL,
  };
}

export function toMarketSkillDtos(
  skills: MarketSkillSource[],
): MarketSkillDto[] {
  return skills.map(toMarketSkillDto);
}

type MarketBundleSource = {
  id: string;
  name: string;
  description: string;
  skill_count: number;
  bundle_token: string;
};

export function toMarketBundleDto(bundle: MarketBundleSource): MarketBundleDto {
  return {
    id: bundle.id,
    name: bundle.name,
    description: bundle.description,
    skill_count: bundle.skill_count,
    bundle_token: bundle.bundle_token,
    author_label: PUBLIC_AUTHOR_LABEL,
  };
}

export function toMarketBundleDtos(
  bundles: MarketBundleSource[],
): MarketBundleDto[] {
  return bundles.map(toMarketBundleDto);
}

/**
 * 转换管理端评论审核行。
 */
export function toAdminSkillCommentDto(
  comment: AdminSkillCommentRow,
): AdminSkillCommentDto {
  return {
    id: comment.id,
    skill_id: comment.skill_id,
    skill_name: comment.skill_name,
    user_id: comment.user_id,
    user_phone: comment.user_phone,
    body: comment.body,
    status: comment.status,
    pinned: comment.pinned,
    reviewed_by: comment.reviewed_by,
    reviewed_at: comment.reviewed_at,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
  };
}

/** 批量转换管理端评论审核行。 */
export function toAdminSkillCommentDtos(
  comments: AdminSkillCommentRow[],
): AdminSkillCommentDto[] {
  return comments.map(toAdminSkillCommentDto);
}
