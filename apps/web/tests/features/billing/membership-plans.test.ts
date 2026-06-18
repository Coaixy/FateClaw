import { describe, expect, it } from 'vitest';

import {
  MEMBERSHIP_CLARITY_PLAN_KEY,
  MEMBERSHIP_DEEP_PLAN_KEY,
  MEMBERSHIP_INSIGHT_PLAN_KEY,
  hasBaseMembershipEntitlement,
  hasCustomModelEntitlement,
  hasWechatClawEntitlement,
  membershipStatusMeetsPlan,
  resolveMembershipPlanDisplayName,
  resolveMembershipPlanShortName,
} from '../../../features/billing/membership-plans';

const baseMembership = {
  enabled: true,
  active: true,
  plan_key: MEMBERSHIP_CLARITY_PLAN_KEY,
  monthly_price_coins: 30,
  display_price_coins: 30,
  current_period_start: '2026-06-01T00:00:00.000Z',
  current_period_end: '2026-07-01T00:00:00.000Z',
  allowance_reset_at: '2026-07-01T00:00:00.000Z',
  allowance_used_ratio: 0,
  allowance_status: 'plenty' as const,
};

describe('membership plan helpers', () => {
  it('keeps base membership available to all paid tiers', () => {
    expect(
      hasBaseMembershipEntitlement({
        ...baseMembership,
        plan_key: MEMBERSHIP_CLARITY_PLAN_KEY,
      }),
    ).toBe(true);
    expect(
      hasBaseMembershipEntitlement({
        ...baseMembership,
        plan_key: MEMBERSHIP_DEEP_PLAN_KEY,
        monthly_price_coins: 100,
        display_price_coins: 100,
      }),
    ).toBe(true);
  });

  it('can express Insight and Deep requirements', () => {
    const clarityMembership = {
      ...baseMembership,
      plan_key: MEMBERSHIP_CLARITY_PLAN_KEY,
    };
    const insightMembership = {
      ...clarityMembership,
      plan_key: MEMBERSHIP_INSIGHT_PLAN_KEY,
      monthly_price_coins: 30,
      display_price_coins: 30,
    };
    const deepMembership = {
      ...clarityMembership,
      plan_key: MEMBERSHIP_DEEP_PLAN_KEY,
      monthly_price_coins: 100,
      display_price_coins: 100,
    };

    expect(
      membershipStatusMeetsPlan(clarityMembership, MEMBERSHIP_INSIGHT_PLAN_KEY),
    ).toBe(false);
    expect(
      membershipStatusMeetsPlan(insightMembership, MEMBERSHIP_INSIGHT_PLAN_KEY),
    ).toBe(true);
    expect(hasCustomModelEntitlement(clarityMembership)).toBe(false);
    expect(hasCustomModelEntitlement(insightMembership)).toBe(true);
    expect(hasWechatClawEntitlement(insightMembership)).toBe(false);
    expect(hasWechatClawEntitlement(deepMembership)).toBe(true);
    expect(
      hasWechatClawEntitlement({
        ...deepMembership,
        enabled: false,
      }),
    ).toBe(true);
  });

  it('keeps unknown active plan rows at the Clarity baseline', () => {
    const legacyMembership = {
      ...baseMembership,
      plan_key: 'legacy_plan',
    };

    expect(hasBaseMembershipEntitlement(legacyMembership)).toBe(true);
    expect(
      membershipStatusMeetsPlan(legacyMembership, MEMBERSHIP_INSIGHT_PLAN_KEY),
    ).toBe(false);
  });

  it('formats known short names by plan key first', () => {
    expect(
      resolveMembershipPlanShortName({
        plan_key: MEMBERSHIP_DEEP_PLAN_KEY,
        name: 'Custom Name',
      }),
    ).toBe('Deep');
    expect(
      resolveMembershipPlanShortName({
        plan_key: MEMBERSHIP_INSIGHT_PLAN_KEY,
        name: 'FateClaw Insight',
      }),
    ).toBe('Insight');
    expect(
      resolveMembershipPlanShortName({
        plan_key: MEMBERSHIP_CLARITY_PLAN_KEY,
        name: 'FateClaw Clarity',
      }),
    ).toBe('Clarity');
  });

  it('formats known display names for the current membership branding', () => {
    expect(
      resolveMembershipPlanDisplayName({
        plan_key: MEMBERSHIP_CLARITY_PLAN_KEY,
        name: 'FateClaw Clarity',
      }),
    ).toBe('FateClaw Clarity');
    expect(
      resolveMembershipPlanDisplayName({
        plan_key: MEMBERSHIP_INSIGHT_PLAN_KEY,
        name: 'FateClaw Insight',
      }),
    ).toBe('FateClaw Insight');
    expect(
      resolveMembershipPlanDisplayName({
        plan_key: MEMBERSHIP_DEEP_PLAN_KEY,
        name: 'FateClaw Deep',
      }),
    ).toBe('FateClaw Deep');
  });
});
