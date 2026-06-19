import { describe, expect, it } from 'vitest';

import {
  MEMBERSHIP_CLARITY_PLAN_KEY,
  MEMBERSHIP_DEEP_PLAN_KEY,
  MEMBERSHIP_INSIGHT_PLAN_KEY,
  hasPaidMembershipEntitlement,
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
      hasPaidMembershipEntitlement({
        ...baseMembership,
        plan_key: MEMBERSHIP_CLARITY_PLAN_KEY,
      }),
    ).toBe(true);
    expect(
      hasPaidMembershipEntitlement({
        ...baseMembership,
        plan_key: MEMBERSHIP_DEEP_PLAN_KEY,
        monthly_price_coins: 100,
        display_price_coins: 100,
      }),
    ).toBe(true);
  });

  it('can express Insight tier requirements via rank', () => {
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

    expect(
      membershipStatusMeetsPlan(clarityMembership, MEMBERSHIP_INSIGHT_PLAN_KEY),
    ).toBe(false);
    expect(
      membershipStatusMeetsPlan(insightMembership, MEMBERSHIP_INSIGHT_PLAN_KEY),
    ).toBe(true);
  });

  it('keeps unknown active plan rows at the Clarity baseline', () => {
    const legacyMembership = {
      ...baseMembership,
      plan_key: 'legacy_plan',
    };

    expect(hasPaidMembershipEntitlement(legacyMembership)).toBe(true);
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
