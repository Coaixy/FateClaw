import { getEnabledAccounts } from '#infrastructure/db';
import { getRuntimeConfig } from '#infrastructure/repositories/runtime-config-repository';
import { logger } from '#infrastructure/logger';
import { getRuntimeEntitlementSnapshot } from '#modules/billing/entitlements';
import type { Account } from '#shared/types';
import { addAccountListener, removeAccountListener } from './ipc-worker.js';
import { startAccountPolling, stopAccountPolling } from './poller.js';

const activeAccounts = new Map<string, Account>();
let timer: NodeJS.Timeout | null = null;
let reconciling: Promise<void> | null = null;
let stopped = false;

function deactivateAccount(accountId: string): void {
  activeAccounts.delete(accountId);
  stopAccountPolling(accountId);
  removeAccountListener(accountId);
}

/** Activation starts a resident loop without holding the binding HTTP request open. */
export async function activateAccount(account: Account): Promise<void> {
  if (
    stopped ||
    !account.enabled ||
    !account.owner_id ||
    activeAccounts.has(account.id)
  )
    return;
  const entitlement = await getRuntimeEntitlementSnapshot(account.owner_id);
  if (
    stopped ||
    !entitlement.canUseWechatClaw ||
    activeAccounts.has(account.id)
  )
    return;
  activeAccounts.set(account.id, account);
  addAccountListener(account.id, { pinned: true });
  void startAccountPolling(account)
    .catch((error) => {
      logger.error({ accountId: account.id, err: error }, '微信 Claw 轮询失败');
    })
    .finally(() => {
      if (activeAccounts.get(account.id) === account)
        deactivateAccount(account.id);
    });
}

export function reconcileWechatAccounts(): Promise<void> {
  if (reconciling) return reconciling;
  reconciling = (async () => {
    const config = await getRuntimeConfig();
    const desired = new Set<string>();
    if (!stopped && config.wechat_claw_enabled) {
      for (const account of await getEnabledAccounts()) {
        if (!account.owner_id) continue;
        const entitlement = await getRuntimeEntitlementSnapshot(
          account.owner_id,
        );
        if (!entitlement.canUseWechatClaw) continue;
        desired.add(account.id);
        await activateAccount(account);
      }
    }
    for (const accountId of activeAccounts.keys()) {
      if (!desired.has(accountId) || stopped) deactivateAccount(accountId);
    }
  })().finally(() => {
    reconciling = null;
  });
  return reconciling;
}

export async function startWechatRuntimeWorker(): Promise<void> {
  if (timer) return;
  stopped = false;
  await reconcileWechatAccounts();
  timer = setInterval(() => {
    void reconcileWechatAccounts().catch((error) => {
      logger.warn({ err: error }, '同步微信 Claw 运行配置失败，将重试');
    });
  }, 10_000);
  timer.unref();
}

export async function stopWechatRuntimeWorker(): Promise<void> {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null;
  await reconciling?.catch(() => {});
  for (const accountId of activeAccounts.keys()) deactivateAccount(accountId);
}
