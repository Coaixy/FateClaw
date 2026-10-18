import type {
  AccountDto,
  AccountSoulDto,
  QrCodeResultDto,
  QrCodeStatusResultDto,
} from '@fateclaw/contracts/account';

import type { Account } from '#shared/types';

/**
 * 用户态账号 DTO。
 * 这里只保留页面需要感知的字段，过滤 bot_token / get_updates_buf 等内部实现细节。
 */
export function toAccountDto(account: Account): AccountDto {
  return {
    id: account.id,
    user_id: account.user_id,
    name: account.name,
    base_url: account.base_url,
    enabled: account.enabled,
    created_at: account.created_at,
    owner_id: account.owner_id,
  };
}

/**
 * 转换用户 Soul 配置 DTO。
 *
 * 参数：
 * - content：Dashboard 维护的用户级 Soul 内容。
 * - editEnabled：是否允许 Pi 在对话中注册 edit_soul 写入工具。
 *
 * 返回：前端 Soul 编辑器使用的配置 DTO。
 */
export function toAccountSoulDto(
  content: string,
  editEnabled = true,
): AccountSoulDto {
  return { content, edit_enabled: editEnabled };
}

export function toQrCodeResultDto(data: {
  qrcode: string;
  qrcode_url: string;
}): QrCodeResultDto {
  return data;
}

export function toQrCodeStatusResultDto(status: string): QrCodeStatusResultDto {
  return {
    status: status as QrCodeStatusResultDto['status'],
  };
}
