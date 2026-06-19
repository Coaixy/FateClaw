/**
 * 账号域跨端契约。
 */

export interface AccountDto {
  id: string;
  user_id: string;
  name: string;
  base_url: string;
  enabled: boolean;
  created_at: string;
  owner_id: string | null;
}

export interface AccountSoulDto {
  /** 是否允许 Pi 在对话中通过 edit_soul 更新 Soul。 */
  edit_enabled: boolean;
  content: string;
}

/** 用户级话术稿模板;content 为空表示沿用平台默认骨架。 */
export interface GuashiScriptTemplateDto {
  content: string;
}

export interface QrCodeResultDto {
  qrcode: string;
  qrcode_url: string;
}

export type QrCodeStatus = 'wait' | 'scaned' | 'expired' | 'confirmed';

export interface QrCodeStatusResultDto {
  status: QrCodeStatus;
}
