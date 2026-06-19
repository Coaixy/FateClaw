/**
 * 账号 HTTP 场景服务层。
 *
 * 负责账号归属校验、账号绑定流程和运行时停启编排，
 * 让 route 只保留请求解析和响应映射。
 */

import type {
  AccountDto,
  AccountSoulDto,
  GuashiScriptTemplateDto,
  QrCodeResultDto,
  QrCodeStatusResultDto,
} from '@fateclaw/contracts/account';
import {
  deleteAccount,
  bindAccountToUser,
  getAccount,
  getAccountsByUserId,
  getSoulContent,
  getUserById,
  getUserSoulEditEnabled,
  getUserSoulContent,
  getUserGuashiScriptTemplate,
  updateSoulContent,
  updateUserSoulEditEnabled,
  updateUserSoulContent,
  updateUserGuashiScriptTemplate,
} from '../../infrastructure/db.js';
import { getLoginQrCode, getQrCodeStatus } from '../../infrastructure/ilink.js';
import { WECHAT_DEVICE_BINDING_DISABLED_MESSAGE } from './account-service.js';
import { removeAccountListener } from '../../runtime/ipc-worker.js';
import { stopLocalAgent } from '../../runtime/local-runner.js';
import { stopAccountPolling } from '../../runtime/poller.js';
import { activateAccount } from '../../app/index.js';
import { fail, ok, type ServiceResult } from '../../shared/service-result.js';
import { getRuntimeEntitlementSnapshot } from '../billing/entitlements.js';
import {
  toAccountDto,
  toAccountSoulDto,
} from '../../contracts-adapter/account-contract.js';

export async function checkAccountBindingLimit(
  userId: string,
): Promise<string | null> {
  const user = await getUserById(userId);
  if (!user) return '用户不存在';
  const entitlement = await getRuntimeEntitlementSnapshot(user.id);
  if (!entitlement.canUseWechatClaw) {
    return WECHAT_DEVICE_BINDING_DISABLED_MESSAGE;
  }
  const accounts = await getAccountsByUserId(user.id);
  if (accounts.length >= 1) return '会员当前最多绑定 1 个微信 Claw';
  return null;
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
  const editEnabled = await getUserSoulEditEnabled(user.id);
  return ok(toAccountSoulDto(content, editEnabled));
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
  editEnabled?: boolean,
): Promise<ServiceResult<{ success: true }>> {
  const user = await getUserById(userId);
  if (!user) {
    return fail(404, '用户不存在');
  }
  await updateUserSoulContent(user.id, content);
  if (editEnabled !== undefined) {
    await updateUserSoulEditEnabled(user.id, editEnabled);
  }
  return ok({ success: true });
}

/**
 * 读取当前用户的话术稿模板;content 为空表示沿用平台默认骨架。
 */
export async function getOwnedUserGuashiScriptTemplate(
  userId: string,
): Promise<ServiceResult<GuashiScriptTemplateDto>> {
  const user = await getUserById(userId);
  if (!user) {
    return fail(404, '用户不存在');
  }
  const content = await getUserGuashiScriptTemplate(user.id);
  return ok({ content });
}

/**
 * 更新当前用户的话术稿模板;存空字符串等价于恢复使用平台默认骨架。
 */
export async function updateOwnedUserGuashiScriptTemplate(
  userId: string,
  content: string,
): Promise<ServiceResult<{ success: true }>> {
  const user = await getUserById(userId);
  if (!user) {
    return fail(404, '用户不存在');
  }
  await updateUserGuashiScriptTemplate(user.id, content);
  return ok({ success: true });
}

/**
 * 更新当前用户是否允许 Pi 在对话中编辑 Soul。
 *
 * 关闭后运行时不会注册 edit_soul，避免模型在对话中写入长期记忆。
 */
export async function updateOwnedUserSoulEditEnabled(
  userId: string,
  editEnabled: boolean,
): Promise<ServiceResult<{ success: true }>> {
  const user = await getUserById(userId);
  if (!user) {
    return fail(404, '用户不存在');
  }
  await updateUserSoulEditEnabled(user.id, editEnabled);
  return ok({ success: true });
}

export async function bindAccountForUser(
  userId: string,
  accountId: string,
): Promise<ServiceResult<{ success: true }>> {
  const limit = await checkAccountBindingLimit(userId);
  if (limit) {
    return fail(limit === '用户不存在' ? 404 : 403, limit);
  }
  const account = await getAccount(accountId);
  if (!account) {
    return fail(404, '账号不存在');
  }
  if (account.owner_id && account.owner_id !== userId) {
    return fail(403, '账号已被其他用户绑定');
  }
  await bindAccountToUser(account.id, userId);
  await activateAccount({ ...account, owner_id: userId });
  return ok({ success: true });
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
  const limit = await checkAccountBindingLimit(userId);
  if (limit) {
    return fail(limit === '用户不存在' ? 404 : 403, limit);
  }
  const qrcode = await getLoginQrCode();
  return ok({
    qrcode: qrcode.qrcode,
    qrcode_url: qrcode.qrcode_img_content,
  });
}

export async function getAccountBindingQrCodeStatus(
  userId: string,
  qrcode: string,
): Promise<ServiceResult<QrCodeStatusResultDto>> {
  const limit = await checkAccountBindingLimit(userId);
  if (limit) {
    return fail(limit === '用户不存在' ? 404 : 403, limit);
  }
  const status = await getQrCodeStatus(qrcode);
  if (status.status !== 'confirmed') {
    return ok({ status: status.status });
  }
  if (!status.ilink_bot_id || !status.ilink_user_id || !status.bot_token) {
    return fail(502, '微信授权结果缺少账号信息');
  }
  const account = await getAccount(status.ilink_bot_id);
  if (account?.owner_id && account.owner_id !== userId) {
    return fail(403, '账号已被其他用户绑定');
  }
  if (account) {
    await bindAccountToUser(account.id, userId);
    await activateAccount({ ...account, owner_id: userId });
  } else {
    const { addAccount } = await import('./account-service.js');
    const created = await addAccount(
      status.ilink_user_id.split('@')[0] ?? '微信用户',
      status.ilink_user_id,
      status.bot_token,
      status.ilink_bot_id,
      status.baseurl,
    );
    await bindAccountToUser(created.id, userId);
    await activateAccount({ ...created, owner_id: userId });
  }
  return ok({ status: 'confirmed' });
}
