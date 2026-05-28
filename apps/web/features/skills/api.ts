import type {
  BundleShareResponseDto,
  BundleSkillPreviewDto,
  BundleSubscribeResultDto,
  BundleUnsubscribeResultDto,
  CreatorEarningsMonthlyDto,
  CreatorWithdrawalDto,
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
  SkillUsageModeDto,
  SubscribedSkillDto,
  UserCustomSkillDto,
  UserSkillsResponseDto,
  WithdrawalBalanceDto,
  WithdrawalRequestResponseDto,
} from '@fateclaw/contracts/skills';

import { requestJson } from '@/lib/http/client';

export type SkillUsageMode = SkillUsageModeDto;
export type SkillPriceTier = SkillPriceTierDto;
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
export type CreatorWithdrawal = CreatorWithdrawalDto;
export type WithdrawalBalance = WithdrawalBalanceDto;
export type CreatorEarningsMonthly = CreatorEarningsMonthlyDto;

export const USER_SKILL_CATEGORIES: readonly string[] = [
  '通用',
  '八字',
  '紫微',
  '六爻',
  '奇门',
  '梅花',
  '大六壬',
  '小六壬',
  '风水',
  '周易',
  '测字',
  '择日',
  '铁板神数',
  '玄空',
  '相术',
  '手相',
  '姓名学',
  '占星',
  '塔罗',
  '生命灵数',
  '人类图',
  '数字能量',
] as const;

// 只保留当前系统能直接排盘/承接的术数建议；其他类别保留给用户手动输入。
export const SYSTEM_PAIPAN_CATEGORIES: readonly string[] = [
  '八字',
  '紫微',
  '六爻',
  '经占',
  '奇门',
] as const;

export const skillsApi = {
  userList: () => requestJson<UserSkillsResponse>('/api/skills/user'),
  userCreate: (data: {
    skill_name: string;
    description?: string;
    trigger_hint?: string;
    content?: string;
    category?: string;
    match_keywords?: string[];
    match_patterns?: string[];
    priority?: number;
    usage_mode?: SkillUsageMode;
  }) =>
    requestJson<UserCustomSkill>('/api/skills/user', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  userUpdate: (
    id: string,
    data: {
      skill_name?: string;
      description?: string;
      trigger_hint?: string;
      content?: string;
      category?: string;
      match_keywords?: string[];
      match_patterns?: string[];
      priority?: number;
      usage_mode?: SkillUsageMode;
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
    category?: string;
    limit?: number;
    offset?: number;
  }) => {
    const qs = new URLSearchParams();
    if (params.category) qs.set('category', params.category);
    if (params.limit != null) qs.set('limit', String(params.limit));
    if (params.offset != null) qs.set('offset', String(params.offset));
    return requestJson<MarketBundle[]>(
      `/api/skills/bundles/market?${qs.toString()}`,
    );
  },
  market: (params: { category?: string; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params.category) qs.set('category', params.category);
    if (params.limit != null) qs.set('limit', String(params.limit));
    if (params.offset != null) qs.set('offset', String(params.offset));
    return requestJson<MarketSkill[]>(`/api/skills/market?${qs.toString()}`);
  },
  earningsMine: () =>
    requestJson<CreatorEarningsMonthly[]>('/api/skills/earnings/mine'),
};

export const withdrawalApi = {
  balance: () =>
    requestJson<WithdrawalBalance>('/api/skills/creator/withdrawal/balance'),
  list: () =>
    requestJson<CreatorWithdrawal[]>('/api/skills/creator/withdrawal/list'),
  create: (data: {
    amount_points: number;
    bank_name?: string;
    bank_account?: string;
    account_name?: string;
    id_number?: string;
    tax_type?: 'personal' | 'company';
    company_name?: string;
    tax_id?: string;
  }) =>
    requestJson<WithdrawalRequestResponseDto>(
      '/api/skills/creator/withdrawal/request',
      {
        method: 'POST',
        body: JSON.stringify(data),
      },
    ),
};
