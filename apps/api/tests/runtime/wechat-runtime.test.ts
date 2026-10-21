import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  config: { wechat_claw_enabled: false },
  entitled: true,
  accounts: vi.fn(),
  poll: vi.fn(),
  stop: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
}));
vi.mock('#infrastructure/db', () => ({ getEnabledAccounts: state.accounts }));
vi.mock('#infrastructure/repositories/runtime-config-repository', () => ({
  getRuntimeConfig: async () => state.config,
}));
vi.mock('#modules/billing/entitlements', () => ({
  getRuntimeEntitlementSnapshot: async () => ({
    canUseWechatClaw: state.entitled,
  }),
}));
vi.mock('#runtime/poller', () => ({
  startAccountPolling: state.poll,
  stopAccountPolling: state.stop,
}));
vi.mock('#runtime/ipc-worker', () => ({
  addAccountListener: state.listen,
  removeAccountListener: state.unlisten,
}));
vi.mock('#infrastructure/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}));

import {
  reconcileWechatAccounts,
  startWechatRuntimeWorker,
  stopWechatRuntimeWorker,
} from '#runtime/wechat-runtime';

beforeEach(() => {
  vi.clearAllMocks();
  state.config = { wechat_claw_enabled: false };
  state.entitled = true;
  state.accounts.mockResolvedValue([
    { id: 'wechat-account', owner_id: 'member', enabled: true },
  ]);
  state.poll.mockImplementation(() => new Promise(() => {}));
});
afterEach(() => stopWechatRuntimeWorker());

describe('live WeChat configuration', () => {
  it('does not load or activate accounts while disabled', async () => {
    await startWechatRuntimeWorker();
    expect(state.accounts).not.toHaveBeenCalled();
    expect(state.poll).not.toHaveBeenCalled();
  });

  it('activates without waiting for long polling and stops after the admin disables access', async () => {
    state.config.wechat_claw_enabled = true;
    await startWechatRuntimeWorker();
    expect(state.poll).toHaveBeenCalledTimes(1);
    await reconcileWechatAccounts();
    expect(state.poll).toHaveBeenCalledTimes(1);
    state.config.wechat_claw_enabled = false;
    await reconcileWechatAccounts();
    expect(state.stop).toHaveBeenCalledWith('wechat-account');
    expect(state.unlisten).toHaveBeenCalledWith('wechat-account');
  });

  it('stops a polling account when membership no longer grants access', async () => {
    state.config.wechat_claw_enabled = true;
    await startWechatRuntimeWorker();
    state.entitled = false;
    await reconcileWechatAccounts();
    expect(state.stop).toHaveBeenCalledWith('wechat-account');
  });
});
