import type {
  MyReferralSummaryDto,
  ReferralInvitePreviewDto,
  ReferralRedeemResultDto,
} from '@fateclaw/contracts/referrals';

import { requestJson } from '@/lib/http/client';

const pathSegment = (value: string) => encodeURIComponent(value);

export type MyReferralSummary = MyReferralSummaryDto;
export type ReferralInvitePreview = ReferralInvitePreviewDto;
export type ReferralRedeemResult = ReferralRedeemResultDto;

export const referralsApi = {
  me: () => requestJson<MyReferralSummary>('/api/referrals/me'),
  preview: (code: string) =>
    requestJson<ReferralInvitePreview>(
      `/api/referrals/invites/${pathSegment(code)}/preview`,
    ),
  redeem: (code: string) =>
    requestJson<ReferralRedeemResult>(
      `/api/referrals/invites/${pathSegment(code)}/redeem`,
      { method: 'POST' },
    ),
};
