import type {
  BundleShareResponseDto,
  BundleSkillPreviewDto,
  BundleSubscribeResultDto,
  BundleUnsubscribeResultDto,
  MarketBundleDto,
  MarketSkillDto,
  SharedBundlePreviewDto,
  SharedSkillPreviewDto,
  SkillBundleDto,
  SkillDeleteResponseDto,
  SkillPriceTierDto,
  SkillShareResponseDto,
  SkillSubscriptionCreateResponseDto,
  SkillSubscriptionToggleResponseDto,
  SubscribedSkillDto,
  TextSkillBundleFileDto,
  UserCustomSkillDto,
  UserSkillsResponseDto,
} from '@fateclaw/contracts/skills';

import { requestJson } from '@/lib/http/client';

export type SkillPriceTier = SkillPriceTierDto;
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
    requestJson<UserCustomSkill>(`/api/skills/user/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  userDelete: (id: string) =>
    requestJson<SkillDeleteResponseDto>(`/api/skills/user/${id}`, {
      method: 'DELETE',
    }),
  userToggle: (id: string) =>
    requestJson<UserCustomSkill>(`/api/skills/user/${id}/toggle`, {
      method: 'PATCH',
    }),
  share: (id: string) =>
    requestJson<SkillShareResponseDto>(`/api/skills/user/${id}/share`, {
      method: 'POST',
    }),
  unshare: (id: string) =>
    requestJson<UserCustomSkill>(`/api/skills/user/${id}/share`, {
      method: 'DELETE',
    }),
  publish: (id: string) =>
    requestJson<SkillShareResponseDto>(`/api/skills/user/${id}/publish`, {
      method: 'POST',
    }),
  unpublish: (id: string) =>
    requestJson<UserCustomSkill>(`/api/skills/user/${id}/publish`, {
      method: 'DELETE',
    }),
  sharedPreview: (token: string) =>
    requestJson<SharedSkillPreview>(`/api/skills/shared/${token}`),
  subscribe: (token: string) =>
    requestJson<SkillSubscriptionCreateResponseDto>(
      `/api/skills/subscribe/${token}`,
      { method: 'POST' },
    ),
  subscriptionToggle: (id: string) =>
    requestJson<SkillSubscriptionToggleResponseDto>(
      `/api/skills/subscribe/${id}/toggle`,
      { method: 'PATCH' },
    ),
  unsubscribe: (id: string) =>
    requestJson<SkillDeleteResponseDto>(`/api/skills/subscribe/${id}`, {
      method: 'DELETE',
    }),
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
    requestJson<SkillBundle>(`/api/skills/bundles/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  bundleDelete: (id: string) =>
    requestJson<SkillDeleteResponseDto>(`/api/skills/bundles/${id}`, {
      method: 'DELETE',
    }),
  bundleShare: (id: string) =>
    requestJson<BundleShareResponseDto>(`/api/skills/bundles/${id}/share`, {
      method: 'POST',
    }),
  bundleUnshare: (id: string) =>
    requestJson<SkillBundle>(`/api/skills/bundles/${id}/share`, {
      method: 'DELETE',
    }),
  bundlePublish: (id: string) =>
    requestJson<BundleShareResponseDto>(`/api/skills/bundles/${id}/publish`, {
      method: 'POST',
    }),
  bundleUnpublish: (id: string) =>
    requestJson<SkillBundle>(`/api/skills/bundles/${id}/publish`, {
      method: 'DELETE',
    }),
  bundlePreview: (token: string) =>
    requestJson<SharedBundlePreview>(`/api/skills/bundles/shared/${token}`),
  bundleSubscribe: (token: string) =>
    requestJson<BundleSubscribeResult>(
      `/api/skills/bundles/subscribe/${token}`,
      { method: 'POST' },
    ),
  bundleUnsubscribe: (bundleId: string) =>
    requestJson<BundleUnsubscribeResult>(
      `/api/skills/bundles/subscriptions/${encodeURIComponent(bundleId)}`,
      { method: 'DELETE' },
    ),
  marketBundles: (params: {
    limit?: number;
    offset?: number;
  }) => {
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
