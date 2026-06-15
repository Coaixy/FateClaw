import { describe, expect, it } from 'vitest';

import {
  MEMBERSHIP_CLARITY_PLAN_KEY,
  MEMBERSHIP_DEEP_PLAN_KEY,
  MEMBERSHIP_INSIGHT_PLAN_KEY,
  MEMBERSHIP_PLUS_PLAN_KEY,
  MEMBERSHIP_PRO_PLAN_KEY,
  hasBaseMembershipEntitlement,
  hasCustomModelEntitlement,
  hasPriorityQueueEntitlement,
  hasWechatClawEntitlement,
  membershipOverviewMeetsPlan,
  membershipPlanMeets,
  normalizeMembershipPlanKey,
  resolveMembershipConfigId,
  resolveMembershipPlanKey,
  resolveMembershipPlanRank,
  resolveProfessionalAiDailyTurnLimit,
} from '../../src/shared/membership-plans.js';

describe('membership plan helpers', () => {
  it('normalizes new and legacy plan keys', () => {
    expect(normalizeMembershipPlanKey(undefined)).toBe(
      MEMBERSHIP_CLARITY_PLAN_KEY,
    );
    expect(normalizeMembershipPlanKey('unknown')).toBe(
      MEMBERSHIP_CLARITY_PLAN_KEY,
    );
    expect(normalizeMembershipPlanKey(MEMBERSHIP_PLUS_PLAN_KEY)).toBe(
      MEMBERSHIP_INSIGHT_PLAN_KEY,
    );
    expect(normalizeMembershipPlanKey(MEMBERSHIP_PRO_PLAN_KEY)).toBe(
      MEMBERSHIP_DEEP_PLAN_KEY,
    );
  });

  it('maps plan keys and config ids consistently', () => {
    expect(resolveMembershipConfigId(MEMBERSHIP_CLARITY_PLAN_KEY)).toBe(
      MEMBERSHIP_CLARITY_PLAN_KEY,
    );
    expect(resolveMembershipConfigId(MEMBERSHIP_INSIGHT_PLAN_KEY)).toBe(
      MEMBERSHIP_INSIGHT_PLAN_KEY,
    );
    expect(resolveMembershipConfigId(MEMBERSHIP_PRO_PLAN_KEY)).toBe(
      MEMBERSHIP_DEEP_PLAN_KEY,
    );
    expect(resolveMembershipPlanKey('default')).toBe(
      MEMBERSHIP_INSIGHT_PLAN_KEY,
    );
    expect(resolveMembershipPlanKey(MEMBERSHIP_PRO_PLAN_KEY)).toBe(
      MEMBERSHIP_DEEP_PLAN_KEY,
    );
  });

  it('orders Clarity, Insight and Deep by rank', () => {
    expect(resolveMembershipPlanRank(MEMBERSHIP_CLARITY_PLAN_KEY)).toBe(1);
    expect(resolveMembershipPlanRank(MEMBERSHIP_INSIGHT_PLAN_KEY)).toBe(2);
    expect(resolveMembershipPlanRank(MEMBERSHIP_DEEP_PLAN_KEY)).toBe(3);
    expect(
      membershipPlanMeets(
        MEMBERSHIP_DEEP_PLAN_KEY,
        MEMBERSHIP_INSIGHT_PLAN_KEY,
      ),
    ).toBe(true);
    expect(
      membershipPlanMeets(
        MEMBERSHIP_CLARITY_PLAN_KEY,
        MEMBERSHIP_INSIGHT_PLAN_KEY,
      ),
    ).toBe(false);
  });

  it('keeps paid membership entitlement available to all paid tiers', () => {
    expect(
      hasBaseMembershipEntitlement({
        active: true,
        membership: { plan_key: MEMBERSHIP_CLARITY_PLAN_KEY },
      }),
    ).toBe(true);
    expect(
      hasBaseMembershipEntitlement({
        active: true,
        membership: { plan_key: MEMBERSHIP_DEEP_PLAN_KEY },
      }),
    ).toBe(true);
    expect(
      hasBaseMembershipEntitlement({ active: false, membership: null }),
    ).toBe(false);
  });

  it('keeps unknown active plan rows at the Clarity baseline', () => {
    expect(
      membershipOverviewMeetsPlan(
        {
          active: true,
          membership: { plan_key: 'legacy_plan' },
        },
        MEMBERSHIP_INSIGHT_PLAN_KEY,
      ),
    ).toBe(false);
  });

  it('expresses split entitlements explicitly', () => {
    expect(
      hasCustomModelEntitlement({
        active: true,
        membership: { plan_key: MEMBERSHIP_CLARITY_PLAN_KEY },
      }),
    ).toBe(false);
    expect(
      hasCustomModelEntitlement({
        active: true,
        membership: { plan_key: MEMBERSHIP_INSIGHT_PLAN_KEY },
      }),
    ).toBe(true);
    expect(
      hasPriorityQueueEntitlement({
        active: true,
        membership: { plan_key: MEMBERSHIP_INSIGHT_PLAN_KEY },
      }),
    ).toBe(true);
    expect(
      hasWechatClawEntitlement({
        active: true,
        membership: { plan_key: MEMBERSHIP_INSIGHT_PLAN_KEY },
      }),
    ).toBe(false);
    expect(
      hasWechatClawEntitlement({
        active: true,
        membership: { plan_key: MEMBERSHIP_DEEP_PLAN_KEY },
      }),
    ).toBe(true);
  });

  it('resolves professional AI daily limits by tier', () => {
    expect(resolveProfessionalAiDailyTurnLimit(null)).toBe(0);
    expect(
      resolveProfessionalAiDailyTurnLimit(MEMBERSHIP_CLARITY_PLAN_KEY),
    ).toBe(10);
    expect(
      resolveProfessionalAiDailyTurnLimit(MEMBERSHIP_INSIGHT_PLAN_KEY),
    ).toBe(30);
    expect(resolveProfessionalAiDailyTurnLimit(MEMBERSHIP_DEEP_PLAN_KEY)).toBe(
      100,
    );
  });
});
