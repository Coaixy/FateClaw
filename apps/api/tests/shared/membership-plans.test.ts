import { describe, expect, it } from 'vitest';

import {
  MEMBERSHIP_PLUS_PLAN_KEY,
  MEMBERSHIP_PRO_PLAN_KEY,
  hasBaseMembershipEntitlement,
  membershipOverviewMeetsPlan,
  membershipPlanMeets,
  normalizeMembershipPlanKey,
  resolveMembershipConfigId,
  resolveMembershipPlanKey,
  resolveMembershipPlanRank,
} from '../../src/shared/membership-plans.js';

describe('membership plan helpers', () => {
  it('normalizes unknown plan keys to the historical Plus default', () => {
    expect(normalizeMembershipPlanKey(undefined)).toBe(
      MEMBERSHIP_PLUS_PLAN_KEY,
    );
    expect(normalizeMembershipPlanKey('unknown')).toBe(
      MEMBERSHIP_PLUS_PLAN_KEY,
    );
    expect(normalizeMembershipPlanKey(MEMBERSHIP_PRO_PLAN_KEY)).toBe(
      MEMBERSHIP_PRO_PLAN_KEY,
    );
  });

  it('maps plan keys and config ids consistently', () => {
    expect(resolveMembershipConfigId(MEMBERSHIP_PLUS_PLAN_KEY)).toBe('default');
    expect(resolveMembershipConfigId(MEMBERSHIP_PRO_PLAN_KEY)).toBe(
      MEMBERSHIP_PRO_PLAN_KEY,
    );
    expect(resolveMembershipPlanKey('default')).toBe(MEMBERSHIP_PLUS_PLAN_KEY);
    expect(resolveMembershipPlanKey(MEMBERSHIP_PRO_PLAN_KEY)).toBe(
      MEMBERSHIP_PRO_PLAN_KEY,
    );
  });

  it('treats Pro as a higher tier than Plus', () => {
    expect(resolveMembershipPlanRank(MEMBERSHIP_PLUS_PLAN_KEY)).toBe(1);
    expect(resolveMembershipPlanRank(MEMBERSHIP_PRO_PLAN_KEY)).toBe(2);
    expect(
      membershipPlanMeets(MEMBERSHIP_PRO_PLAN_KEY, MEMBERSHIP_PLUS_PLAN_KEY),
    ).toBe(true);
    expect(
      membershipPlanMeets(MEMBERSHIP_PLUS_PLAN_KEY, MEMBERSHIP_PRO_PLAN_KEY),
    ).toBe(false);
  });

  it('keeps current base membership entitlement available to Plus and Pro', () => {
    expect(
      hasBaseMembershipEntitlement({
        active: true,
        membership: { plan_key: MEMBERSHIP_PLUS_PLAN_KEY },
      }),
    ).toBe(true);
    expect(
      hasBaseMembershipEntitlement({
        active: true,
        membership: { plan_key: MEMBERSHIP_PRO_PLAN_KEY },
      }),
    ).toBe(true);
    expect(
      hasBaseMembershipEntitlement({ active: false, membership: null }),
    ).toBe(false);
  });

  it('keeps unknown active plan rows compatible with the Plus baseline', () => {
    expect(
      hasBaseMembershipEntitlement({
        active: true,
        membership: { plan_key: 'legacy_plan' },
      }),
    ).toBe(true);
    expect(
      membershipOverviewMeetsPlan(
        {
          active: true,
          membership: { plan_key: 'legacy_plan' },
        },
        MEMBERSHIP_PRO_PLAN_KEY,
      ),
    ).toBe(false);
  });

  it('can express future Pro-only entitlements without changing callers', () => {
    expect(
      membershipOverviewMeetsPlan(
        {
          active: true,
          membership: { plan_key: MEMBERSHIP_PLUS_PLAN_KEY },
        },
        MEMBERSHIP_PRO_PLAN_KEY,
      ),
    ).toBe(false);
    expect(
      membershipOverviewMeetsPlan(
        {
          active: true,
          membership: { plan_key: MEMBERSHIP_PRO_PLAN_KEY },
        },
        MEMBERSHIP_PRO_PLAN_KEY,
      ),
    ).toBe(true);
  });
});
