import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ member: true, wechat: false }));
vi.mock('#infrastructure/db', () => ({
  expireUserBonusBalanceBefore: async () => {},
  getMembershipOverview: async () => ({ active: state.member }),
  getUserById: async () => ({
    purchased_coins: 10,
    bonus_coins: 0,
    reserved_coins: 0,
  }),
  getRuntimeConfig: async () => ({ wechat_claw_enabled: state.wechat }),
}));
import { getRuntimeEntitlementSnapshot } from '#modules/billing/entitlements';

describe('WeChat entitlement', () => {
  beforeEach(() => {
    state.member = true;
    state.wechat = false;
  });
  it('requires both current admin enablement and active membership', async () => {
    expect(
      (await getRuntimeEntitlementSnapshot('member')).canUseWechatClaw,
    ).toBe(false);
    state.wechat = true;
    expect(
      (await getRuntimeEntitlementSnapshot('member')).canUseWechatClaw,
    ).toBe(true);
    state.member = false;
    expect(
      (await getRuntimeEntitlementSnapshot('member')).canUseWechatClaw,
    ).toBe(false);
  });
});
