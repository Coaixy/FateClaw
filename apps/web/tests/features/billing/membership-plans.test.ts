import { describe, expect, it } from 'vitest';

import {
  MEMBERSHIP_CLARITY_PLAN_KEY,
  hasPaidMembershipEntitlement,
  membershipStatusMeetsPlan,
  resolveMembershipPlanDisplayName,
} from '../../../features/billing/membership-plans';

const baseMembership = {
  enabled: true,
  active: true,
  plan_key: MEMBERSHIP_CLARITY_PLAN_KEY,
  monthly_price_coins: 30,
  display_price_coins: 30,
  current_period_start: '2026-06-01T00:00:00.000Z',
  current_period_end: '2026-07-01T00:00:00.000Z',
};

describe('membership plan helpers', () => {
  it('keeps base membership available to active clarity members', () => {
    expect(
      hasPaidMembershipEntitlement({
        ...baseMembership,
        plan_key: MEMBERSHIP_CLARITY_PLAN_KEY,
      }),
    ).toBe(true);
    expect(hasPaidMembershipEntitlement({ ...baseMembership, active: false })).toBe(
      false,
    );
  });

  it('meets the clarity requirement when active', () => {
    const clarityMembership = {
      ...baseMembership,
      plan_key: MEMBERSHIP_CLARITY_PLAN_KEY,
    };

    expect(
      membershipStatusMeetsPlan(clarityMembership, MEMBERSHIP_CLARITY_PLAN_KEY),
    ).toBe(true);
    expect(
      membershipStatusMeetsPlan(
        { ...clarityMembership, active: false },
        MEMBERSHIP_CLARITY_PLAN_KEY,
      ),
    ).toBe(false);
  });

  it('normalizes unknown active plan rows to the Clarity baseline', () => {
    // 旧档历史 plan_key 归一为 clarity，仍满足 clarity 基线。
    const legacyMembership = {
      ...baseMembership,
      plan_key: 'legacy_plan',
    };

    expect(hasPaidMembershipEntitlement(legacyMembership)).toBe(true);
    expect(
      membershipStatusMeetsPlan(legacyMembership, MEMBERSHIP_CLARITY_PLAN_KEY),
    ).toBe(true);
  });

  it('formats display names for the current membership branding', () => {
    // 单层化后展示名恒为 FateClaw Clarity（不再有 insight/deep 分支）。
    expect(
      resolveMembershipPlanDisplayName({
        plan_key: MEMBERSHIP_CLARITY_PLAN_KEY,
        name: 'FateClaw Clarity',
      }),
    ).toBe('FateClaw Clarity');
    expect(
      resolveMembershipPlanDisplayName({
        plan_key: 'legacy_plan',
        name: 'Custom Name',
      }),
    ).toBe('FateClaw Clarity');
  });
});
