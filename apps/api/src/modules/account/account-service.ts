/**
 * 账号管理：创建、删除、列表。
 */

import {
  createAccount,
  deleteAccount,
  getAccount,
  getAllAccounts,
} from '../../infrastructure/db.js';
import { logger } from '../../infrastructure/logger.js';
import { Account } from '../../shared/types.js';

export const WECHAT_DEVICE_BINDING_DISABLED_MESSAGE =
  '微信设备绑定暂时关闭，已绑定账号数据已清理，后续恢复后可重新绑定。';

export const FREE_WECHAT_UNSUPPORTED_MESSAGE =
  WECHAT_DEVICE_BINDING_DISABLED_MESSAGE;

export function isWechatDeviceBindingDisabled(): boolean {
  return true;
}

export async function addAccount(
  name: string,
  userId: string,
  botToken: string,
  accountId?: string,
  baseUrl: string = 'https://ilinkai.weixin.qq.com',
): Promise<Account> {
  const resolvedAccountId =
    accountId || `bot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const account: Account = {
    id: resolvedAccountId,
    user_id: userId,
    name,
    bot_token: botToken,
    base_url: baseUrl,
    get_updates_buf: '',
    enabled: true,
    created_at: new Date().toISOString(),
    owner_id: null,
  };

  await createAccount(account);
  logger.info({ accountId: resolvedAccountId, name }, '账号已创建');

  return account;
}

export async function removeAccount(accountId: string): Promise<void> {
  const account = await getAccount(accountId);
  if (!account) {
    throw new Error(`未找到账号: ${accountId}`);
  }

  await deleteAccount(accountId);
  logger.info({ accountId }, '账号已移除');
}

export async function listAccounts(): Promise<Account[]> {
  return getAllAccounts();
}
