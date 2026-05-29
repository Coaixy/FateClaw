/**
 * 账号 HTTP 场景服务层。
 *
 * 负责账号归属校验、账号绑定流程和运行时停启编排，
 * 让 route 只保留请求解析和响应映射。
 */

import type {
  AccountDto,
  AccountSoulDto,
  QrCodeResultDto,
  QrCodeStatusResultDto,
} from '@fateclaw/contracts/account';
import {
  deleteAccount,
  getAccount,
  getAccountsByUserId,
  getSoulContent,
  getUserById,
  getUserSoulContent,
  updateSoulContent,
  updateUserSoulContent,
} from '../../infrastructure/db.js';
import { WECHAT_DEVICE_BINDING_DISABLED_MESSAGE } from './account-service.js';
import { removeAccountListener } from '../../runtime/ipc-worker.js';
import { stopLocalAgent } from '../../runtime/local-runner.js';
import { stopAccountPolling } from '../../runtime/poller.js';
import { fail, ok, type ServiceResult } from '../../shared/service-result.js';
import {
  toAccountDto,
  toAccountSoulDto,
} from '../../contracts-adapter/account-contract.js';

export async function checkAccountBindingLimit(
  userId: string,
): Promise<string | null> {
  const user = await getUserById(userId);
  if (!user) return '用户不存在';
  return WECHAT_DEVICE_BINDING_DISABLED_MESSAGE;
}

export async function listSafeAccountsForUser(
  userId: string,
): Promise<AccountDto[]> {
  const accounts = await getAccountsByUserId(userId);
  return accounts.map(toAccountDto);
}

export async function getSafeOwnedAccount(
  userId: string,
  accountId: string,
): Promise<AccountDto | null> {
  const account = await getAccount(accountId);
  if (!account || account.owner_id !== userId) {
    return null;
  }
  return toAccountDto(account);
}

export async function getOwnedSoulContent(
  userId: string,
  accountId: string,
): Promise<ServiceResult<AccountSoulDto>> {
  const account = await getAccount(accountId);
  if (!account || account.owner_id !== userId) {
    return fail(404, '账号不存在');
  }
  const content = await getSoulContent(account.id);
  return ok(toAccountSoulDto(content));
}

/**
 * 读取当前用户的用户级 Soul 自定义人格。
 *
 * 这份配置不依赖微信账号，站内 AI Chat 会优先注入它。
 */
export async function getOwnedUserSoulContent(
  userId: string,
): Promise<ServiceResult<AccountSoulDto>> {
  const user = await getUserById(userId);
  if (!user) {
    return fail(404, '用户不存在');
  }
  const content = await getUserSoulContent(user.id);
  return ok(toAccountSoulDto(content));
}

export async function updateOwnedSoulContent(
  userId: string,
  accountId: string,
  content: string,
): Promise<ServiceResult<{ success: true }>> {
  const account = await getAccount(accountId);
  if (!account || account.owner_id !== userId) {
    return fail(404, '账号不存在');
  }
  await updateSoulContent(account.id, content);
  return ok({ success: true });
}

/**
 * 更新当前用户的用户级 Soul 自定义人格。
 *
 * 保存后新的站内 AI Chat 请求会通过 Pi Runtime context 注入这份内容。
 */
export async function updateOwnedUserSoulContent(
  userId: string,
  content: string,
): Promise<ServiceResult<{ success: true }>> {
  const user = await getUserById(userId);
  if (!user) {
    return fail(404, '用户不存在');
  }
  await updateUserSoulContent(user.id, content);
  return ok({ success: true });
}

export async function bindAccountForUser(
  userId: string,
  accountId: string,
): Promise<ServiceResult<{ success: true }>> {
  void userId;
  void accountId;
  return fail(403, WECHAT_DEVICE_BINDING_DISABLED_MESSAGE);
}

export async function deleteOwnedAccountAndRuntime(
  userId: string,
  accountId: string,
): Promise<ServiceResult<{ success: true }>> {
  const account = await getAccount(accountId);
  if (!account || account.owner_id !== userId) {
    return fail(404, '账号不存在');
  }
  stopAccountPolling(account.id);
  removeAccountListener(account.id);
  stopLocalAgent(account.id);
  await updateSoulContent(account.id, '');
  await deleteAccount(account.id);

  return ok({ success: true });
}

export async function requestAccountBindingQrCode(
  userId: string,
): Promise<ServiceResult<QrCodeResultDto>> {
  void userId;
  return fail(403, WECHAT_DEVICE_BINDING_DISABLED_MESSAGE);
}

export async function getAccountBindingQrCodeStatus(
  userId: string,
  qrcode: string,
): Promise<ServiceResult<QrCodeStatusResultDto>> {
  void userId;
  void qrcode;
  return fail(403, WECHAT_DEVICE_BINDING_DISABLED_MESSAGE);
}
