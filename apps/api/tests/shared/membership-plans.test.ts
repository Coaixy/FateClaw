import { describe, expect, it } from 'vitest';

import {
  MEMBERSHIP_CLARITY_PLAN_KEY,
  hasPaidMembershipEntitlement,
  membershipOverviewMeetsPlan,
  membershipPlanMeets,
  normalizeMembershipPlanKey,
  resolveMembershipConfigId,
  resolveMembershipPlanKey,
  resolveMembershipPlanRank,
} from '../../src/shared/membership-plans.js';

describe('membership plan helpers', () => {
  it('normalizes any non-clarity input back to clarity', () => {
    // 单层化后只有 clarity：空值、未知值、已归一的旧档历史值都回落到 clarity。
    expect(normalizeMembershipPlanKey(undefined)).toBe(
      MEMBERSHIP_CLARITY_PLAN_KEY,
    );
    expect(normalizeMembershipPlanKey('unknown')).toBe(
      MEMBERSHIP_CLARITY_PLAN_KEY,
    );
    expect(normalizeMembershipPlanKey('fateclaw_plus')).toBe(
      MEMBERSHIP_CLARITY_PLAN_KEY,
    );
    expect(normalizeMembershipPlanKey(MEMBERSHIP_CLARITY_PLAN_KEY)).toBe(
      MEMBERSHIP_CLARITY_PLAN_KEY,
    );
  });

  it('maps plan keys and config ids consistently to clarity', () => {
    // 单层化后 config id 与 plan key 双向解析恒归一到 clarity。
    expect(resolveMembershipConfigId(MEMBERSHIP_CLARITY_PLAN_KEY)).toBe(
      MEMBERSHIP_CLARITY_PLAN_KEY,
    );
    expect(resolveMembershipConfigId('fateclaw_pro')).toBe(
      MEMBERSHIP_CLARITY_PLAN_KEY,
    );
    expect(resolveMembershipPlanKey('default')).toBe(
      MEMBERSHIP_CLARITY_PLAN_KEY,
    );
    expect(resolveMembershipPlanKey('fateclaw_pro')).toBe(
      MEMBERSHIP_CLARITY_PLAN_KEY,
    );
  });

  it('ranks only Clarity at tier 1', () => {
    // 单层下 clarity rank=1，其余（未知/旧档）rank=0。
    expect(resolveMembershipPlanRank(MEMBERSHIP_CLARITY_PLAN_KEY)).toBe(1);
    expect(resolveMembershipPlanRank('unknown')).toBe(0);
    expect(
      membershipPlanMeets(MEMBERSHIP_CLARITY_PLAN_KEY, MEMBERSHIP_CLARITY_PLAN_KEY),
    ).toBe(true);
    expect(membershipPlanMeets(null, MEMBERSHIP_CLARITY_PLAN_KEY)).toBe(false);
  });

  it('keeps paid membership entitlement available to active clarity members', () => {
    expect(
      hasPaidMembershipEntitlement({
        active: true,
        membership: { plan_key: MEMBERSHIP_CLARITY_PLAN_KEY },
      }),
    ).toBe(true);
    expect(
      hasPaidMembershipEntitlement({ active: false, membership: null }),
    ).toBe(false);
  });

  it('keeps unknown active plan rows at the Clarity baseline', () => {
    // 旧档历史值归一为 clarity，恰好达到 clarity 基线。
    expect(
      membershipOverviewMeetsPlan(
        {
          active: true,
          membership: { plan_key: 'legacy_plan' },
        },
        MEMBERSHIP_CLARITY_PLAN_KEY,
      ),
    ).toBe(true);
  });
});
