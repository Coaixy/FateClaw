import type {
  BundleSubscriptionSourceDto,
  MarketBundleDto,
  MarketSkillDto,
  SharedBundlePreviewDto,
  SharedSkillPreviewDto,
  SubscribedSkillDto,
  UserCustomSkillDto,
} from '@fateclaw/contracts/skills';

import type {
  SkillBundle,
  SkillPriceTier,
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
    content_length: skill.content_length,
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
  price_tiers: Array<Pick<SkillPriceTier, 'key' | 'label' | 'price_coins'>>;
  stat_subscriber_count: number;
  share_token: string | null;
};

export function toMarketSkillDto(skill: MarketSkillSource): MarketSkillDto {
  return {
    id: skill.id,
    skill_name: skill.skill_name,
    description: skill.description,
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
