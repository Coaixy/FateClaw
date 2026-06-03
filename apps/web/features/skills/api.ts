import {
  MAX_SKILL_BUNDLE_FILE_LENGTH,
  MAX_SKILL_BUNDLE_FILES,
  MAX_SKILL_BUNDLE_TOTAL_LENGTH,
} from '@fateclaw/contracts/skills';

import type {
  BundleShareResponseDto,
  BundleSkillPreviewDto,
  BundleSubscribeResultDto,
  BundleUnsubscribeResultDto,
  CreateSkillAccessInviteRequestDto,
  MarketBundleDto,
  MarketSkillDto,
  SharedBundlePreviewDto,
  SharedSkillPreviewDto,
  SkillAccessInviteDto,
  SkillAccessInvitePreviewDto,
  SkillAccessInviteRedeemResultDto,
  SkillBundleDto,
  SkillDeleteResponseDto,
  SkillShareResponseDto,
  SkillSubscriptionCreateResponseDto,
  SkillSubscriptionToggleResponseDto,
  SubscribedSkillDto,
  TextSkillBundleFileDto,
  UserCustomSkillDto,
  UserSkillsResponseDto,
} from '@fateclaw/contracts/skills';

import { requestJson } from '@/lib/http/client';

export type TextSkillBundleFile = TextSkillBundleFileDto;
export type UserCustomSkill = UserCustomSkillDto;
export type SubscribedSkill = SubscribedSkillDto;
export type UserSkillsResponse = UserSkillsResponseDto;
export type SharedSkillPreview = SharedSkillPreviewDto;
export type SkillBundle = SkillBundleDto;
export type BundleSkillPreview = BundleSkillPreviewDto;
export type SharedBundlePreview = SharedBundlePreviewDto;
export type BundleSubscribeResult = BundleSubscribeResultDto;
export type BundleUnsubscribeResult = BundleUnsubscribeResultDto;
export type MarketBundle = MarketBundleDto;
export type MarketSkill = MarketSkillDto;
export type SkillAccessInvite = SkillAccessInviteDto;
export type SkillAccessInvitePreview = SkillAccessInvitePreviewDto;
export type SkillAccessInviteRedeemResult = SkillAccessInviteRedeemResultDto;
export {
  MAX_SKILL_BUNDLE_FILE_LENGTH,
  MAX_SKILL_BUNDLE_FILES,
  MAX_SKILL_BUNDLE_TOTAL_LENGTH,
};

const pathSegment = (value: string) => encodeURIComponent(value);

export const skillsApi = {
  userList: () => requestJson<UserSkillsResponse>('/api/skills/user'),
  userCreate: (data: {
    skill_name: string;
    dir_name?: string;
    files: TextSkillBundleFile[];
  }) =>
    requestJson<UserCustomSkill>('/api/skills/user', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  userUpdate: (
    id: string,
    data: {
      skill_name?: string;
      files?: TextSkillBundleFile[];
    },
  ) =>
    requestJson<UserCustomSkill>(`/api/skills/user/${pathSegment(id)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  userDelete: (id: string) =>
    requestJson<SkillDeleteResponseDto>(`/api/skills/user/${pathSegment(id)}`, {
      method: 'DELETE',
    }),
  userToggle: (id: string) =>
    requestJson<UserCustomSkill>(`/api/skills/user/${pathSegment(id)}/toggle`, {
      method: 'PATCH',
    }),
  share: (id: string) =>
    requestJson<SkillShareResponseDto>(
      `/api/skills/user/${pathSegment(id)}/share`,
      {
        method: 'POST',
      },
    ),
  unshare: (id: string) =>
    requestJson<UserCustomSkill>(`/api/skills/user/${pathSegment(id)}/share`, {
      method: 'DELETE',
    }),
  publish: (id: string) =>
    requestJson<SkillShareResponseDto>(
      `/api/skills/user/${pathSegment(id)}/publish`,
      {
        method: 'POST',
      },
    ),
  unpublish: (id: string) =>
    requestJson<UserCustomSkill>(
      `/api/skills/user/${pathSegment(id)}/publish`,
      {
        method: 'DELETE',
      },
    ),
  sharedPreview: (token: string) =>
    requestJson<SharedSkillPreview>(`/api/skills/shared/${pathSegment(token)}`),
  subscribe: (token: string) =>
    requestJson<SkillSubscriptionCreateResponseDto>(
      `/api/skills/subscribe/${pathSegment(token)}`,
      { method: 'POST' },
    ),
  accessInviteCreate: (data: CreateSkillAccessInviteRequestDto) =>
    requestJson<SkillAccessInvite>('/api/skills/access-invites', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  accessInviteList: (params: { target_type?: 'skill' | 'bundle'; target_id?: string }) => {
    const qs = new URLSearchParams();
    if (params.target_type) qs.set('target_type', params.target_type);
    if (params.target_id) qs.set('target_id', params.target_id);
    const query = qs.toString();
    return requestJson<SkillAccessInvite[]>(
      `/api/skills/access-invites${query ? `?${query}` : ''}`,
    );
  },
  accessInvitePreview: (token: string) =>
    requestJson<SkillAccessInvitePreview>(
      `/api/skills/access-invites/${pathSegment(token)}`,
    ),
  accessInviteRedeem: (token: string) =>
    requestJson<SkillAccessInviteRedeemResult>(
      `/api/skills/access-invites/${pathSegment(token)}/redeem`,
      { method: 'POST' },
    ),
  accessInviteRevoke: (id: string) =>
    requestJson<SkillAccessInvite>(
      `/api/skills/access-invites/${pathSegment(id)}`,
      { method: 'DELETE' },
    ),
  subscriptionToggle: (id: string) =>
    requestJson<SkillSubscriptionToggleResponseDto>(
      `/api/skills/subscribe/${pathSegment(id)}/toggle`,
      { method: 'PATCH' },
    ),
  unsubscribe: (id: string) =>
    requestJson<SkillDeleteResponseDto>(
      `/api/skills/subscribe/${pathSegment(id)}`,
      {
        method: 'DELETE',
      },
    ),
  bundleList: () => requestJson<SkillBundle[]>('/api/skills/bundles'),
  bundleCreate: (data: {
    name: string;
    description?: string;
    skill_ids: string[];
  }) =>
    requestJson<SkillBundle>('/api/skills/bundles', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  bundleUpdate: (
    id: string,
    data: { name?: string; description?: string; skill_ids?: string[] },
  ) =>
    requestJson<SkillBundle>(`/api/skills/bundles/${pathSegment(id)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  bundleDelete: (id: string) =>
    requestJson<SkillDeleteResponseDto>(
      `/api/skills/bundles/${pathSegment(id)}`,
      {
        method: 'DELETE',
      },
    ),
  bundleShare: (id: string) =>
    requestJson<BundleShareResponseDto>(
      `/api/skills/bundles/${pathSegment(id)}/share`,
      {
        method: 'POST',
      },
    ),
  bundleUnshare: (id: string) =>
    requestJson<SkillBundle>(`/api/skills/bundles/${pathSegment(id)}/share`, {
      method: 'DELETE',
    }),
  bundlePublish: (id: string) =>
    requestJson<BundleShareResponseDto>(
      `/api/skills/bundles/${pathSegment(id)}/publish`,
      {
        method: 'POST',
      },
    ),
  bundleUnpublish: (id: string) =>
    requestJson<SkillBundle>(`/api/skills/bundles/${pathSegment(id)}/publish`, {
      method: 'DELETE',
    }),
  bundlePreview: (token: string) =>
    requestJson<SharedBundlePreview>(
      `/api/skills/bundles/shared/${pathSegment(token)}`,
    ),
  bundleSubscribe: (token: string) =>
    requestJson<BundleSubscribeResult>(
      `/api/skills/bundles/subscribe/${pathSegment(token)}`,
      { method: 'POST' },
    ),
  bundleUnsubscribe: (bundleId: string) =>
    requestJson<BundleUnsubscribeResult>(
      `/api/skills/bundles/subscriptions/${pathSegment(bundleId)}`,
      { method: 'DELETE' },
    ),
  marketBundles: (params: { limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params.limit != null) qs.set('limit', String(params.limit));
    if (params.offset != null) qs.set('offset', String(params.offset));
    return requestJson<MarketBundle[]>(
      `/api/skills/bundles/market?${qs.toString()}`,
    );
  },
  market: (params: { limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params.limit != null) qs.set('limit', String(params.limit));
    if (params.offset != null) qs.set('offset', String(params.offset));
    return requestJson<MarketSkill[]>(`/api/skills/market?${qs.toString()}`);
  },
};
