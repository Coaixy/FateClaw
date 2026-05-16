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
