import { describe, expect, it } from 'vitest';

import {
  MEMBERSHIP_PLUS_PLAN_KEY,
  MEMBERSHIP_PRO_PLAN_KEY,
  hasBaseMembershipEntitlement,
  membershipStatusMeetsPlan,
  resolveMembershipPlanDisplayName,
  resolveMembershipPlanShortName,
} from '../../../features/billing/membership-plans';

const baseMembership = {
  enabled: true,
  active: true,
  plan_key: MEMBERSHIP_PLUS_PLAN_KEY,
  monthly_price_coins: 30,
  display_price_coins: 30,
  current_period_start: '2026-06-01T00:00:00.000Z',
  current_period_end: '2026-07-01T00:00:00.000Z',
  allowance_reset_at: '2026-07-01T00:00:00.000Z',
  allowance_used_ratio: 0,
  allowance_status: 'plenty' as const,
};

describe('membership plan helpers', () => {
  it('keeps base membership available to Plus and Pro', () => {
    expect(
      hasBaseMembershipEntitlement({
        ...baseMembership,
        plan_key: MEMBERSHIP_PLUS_PLAN_KEY,
      }),
    ).toBe(true);
    expect(
      hasBaseMembershipEntitlement({
        ...baseMembership,
        plan_key: MEMBERSHIP_PRO_PLAN_KEY,
        monthly_price_coins: 100,
        display_price_coins: 120,
      }),
    ).toBe(true);
  });

  it('can express Pro-only requirements', () => {
    const plusMembership = {
      ...baseMembership,
      plan_key: MEMBERSHIP_PLUS_PLAN_KEY,
    };
    const proMembership = {
      ...plusMembership,
      plan_key: MEMBERSHIP_PRO_PLAN_KEY,
      monthly_price_coins: 100,
      display_price_coins: 120,
    };

    expect(
      membershipStatusMeetsPlan(plusMembership, MEMBERSHIP_PRO_PLAN_KEY),
    ).toBe(false);
    expect(
      membershipStatusMeetsPlan(proMembership, MEMBERSHIP_PRO_PLAN_KEY),
    ).toBe(true);
  });

  it('keeps unknown active plan rows compatible with the Plus baseline', () => {
    const legacyMembership = {
      ...baseMembership,
      plan_key: 'legacy_plan',
    };

    expect(hasBaseMembershipEntitlement(legacyMembership)).toBe(true);
    expect(
      membershipStatusMeetsPlan(legacyMembership, MEMBERSHIP_PRO_PLAN_KEY),
    ).toBe(false);
  });

  it('formats known short names by plan key first', () => {
    expect(
      resolveMembershipPlanShortName({
        plan_key: MEMBERSHIP_PRO_PLAN_KEY,
        name: 'Custom Name',
      }),
    ).toBe('Deep');
    expect(
      resolveMembershipPlanShortName({
        plan_key: MEMBERSHIP_PLUS_PLAN_KEY,
        name: 'FateClaw Plus',
      }),
    ).toBe('Insight');
  });

  it('formats known display names for the current membership branding', () => {
    expect(
      resolveMembershipPlanDisplayName({
        plan_key: MEMBERSHIP_PLUS_PLAN_KEY,
        name: 'FateClaw Plus',
      }),
    ).toBe('FateClaw Insight');
    expect(
      resolveMembershipPlanDisplayName({
        plan_key: MEMBERSHIP_PRO_PLAN_KEY,
        name: 'FateClaw Pro',
      }),
    ).toBe('FateClaw Deep');
  });
});
