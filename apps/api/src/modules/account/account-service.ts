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
  '微信 Claw 功能当前未开放。';

export const FREE_WECHAT_UNSUPPORTED_MESSAGE = '微信 Claw 功能当前未开放。';

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
    // 微信 Claw 已可逆停用（WECHAT_CLAW_FEATURE_ENABLED=false / 迁移 0057 把存量账号置 false）。
    // CLI 新建账号默认 enabled=false，堵住绕过停用拉起 iLink 轮询的活口；恢复功能时再统一启用。
    enabled: false,
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
