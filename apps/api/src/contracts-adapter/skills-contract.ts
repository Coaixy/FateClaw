import type {
  BundleSubscriptionSourceDto,
  CreatorEarningsMonthlyDto,
  CreatorWithdrawalDto,
  MarketBundleDto,
  MarketSkillDto,
  SharedBundlePreviewDto,
  SharedSkillPreviewDto,
  SubscribedSkillDto,
  UserCustomSkillDto,
  WithdrawalBalanceDto,
  WithdrawalRequestResponseDto,
} from '@nanoclaw/contracts/skills';

import type {
  CreatorEarningsMonthly,
  SkillBundle,
  SkillPriceTier,
  CreatorWithdrawal,
  User,
  UserCustomSkill,
} from '../shared/types.js';
import {
  maskIdNumber,
  safeDecryptSkillSensitiveValue,
} from '../modules/skills/skills-service.js';

/**
 * 公开分享与订阅场景不再暴露创作者联系方式，只返回统一的安全标识。
 */
const PUBLIC_AUTHOR_LABEL = '匿名作者';

/**
 * 创作者与提现相关 DTO 映射。
 * 这里集中处理脱敏逻辑，避免 route 层重复拼装。
 */
export function toCreatorWithdrawalDto(
  row: CreatorWithdrawal,
): CreatorWithdrawalDto {
  return {
    id: row.id,
    amount_points: row.amount_points,
    amount_yuan: row.amount_yuan,
    status: row.status,
    bank_name: row.bank_name,
    bank_account: row.bank_account,
    account_name: row.account_name,
    id_number_masked: row.id_number
      ? maskIdNumber(safeDecryptSkillSensitiveValue(row.id_number))
      : null,
    tax_type: row.tax_type,
    platform_fee_points: row.platform_fee_points,
    tax_amount_yuan: row.tax_amount_yuan,
    net_amount_yuan: row.net_amount_yuan,
    review_note: row.review_note,
    reviewed_at: row.reviewed_at,
    paid_at: row.paid_at,
    created_at: row.created_at,
  };
}

export function toCreatorEarningsMonthlyDtos(
  rows: CreatorEarningsMonthly[],
): CreatorEarningsMonthlyDto[] {
  return rows;
}

export function toWithdrawalBalanceDto(user: User): WithdrawalBalanceDto {
  const withdrawable = Math.max(
    0,
    user.earned_points - user.pending_withdrawal_points,
  );

  return {
    earned_points: user.earned_points,
    pending_withdrawal_points: user.pending_withdrawal_points,
    withdrawable_points: withdrawable,
    withdrawable_yuan: (withdrawable / 100).toFixed(2),
  };
}

export function toWithdrawalRequestResponseDto(
  row: Pick<
    CreatorWithdrawal,
    'id' | 'amount_points' | 'amount_yuan' | 'status' | 'created_at'
  >,
): WithdrawalRequestResponseDto {
  return {
    id: row.id,
    amount_points: row.amount_points,
    amount_yuan: row.amount_yuan,
    status: row.status,
    created_at: row.created_at,
  };
}

function toUserCustomSkillDto(skill: UserCustomSkill): UserCustomSkillDto {
  return {
    id: skill.id,
    user_id: skill.user_id,
    skill_name: skill.skill_name,
    dir_name: skill.dir_name,
    description: skill.description,
    trigger_hint: skill.trigger_hint,
    version: skill.version,
    bundle_uri: skill.bundle_uri,
    checksum: skill.checksum,
    install_status: skill.install_status,
    acl: skill.acl,
    billing_policy: skill.billing_policy,
    audit_metadata: skill.audit_metadata,
    content: skill.content,
    category: skill.category,
    category_normalized: skill.category_normalized,
    match_keywords: skill.match_keywords,
    match_patterns: skill.match_patterns,
    example_queries: skill.example_queries,
    priority: skill.priority,
    usage_mode: skill.usage_mode,
    visibility: skill.visibility,
    share_token: skill.share_token,
    enabled: skill.enabled,
    price_tiers: skill.price_tiers,
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
    trigger_hint: skill.trigger_hint,
    category: skill.category,
    content_length: skill.content.length,
    price_tiers: skill.price_tiers,
    author_label: PUBLIC_AUTHOR_LABEL,
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

type MarketSkillSource = {
  id: string;
  skill_name: string;
  description: string;
  category: string;
  price_tiers: Array<Pick<SkillPriceTier, 'key' | 'label' | 'price_points'>>;
  stat_subscriber_count: number;
  share_token: string | null;
};

export function toMarketSkillDto(skill: MarketSkillSource): MarketSkillDto {
  return {
    id: skill.id,
    skill_name: skill.skill_name,
    description: skill.description,
    category: skill.category,
    price_tiers: skill.price_tiers,
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
