const MAINLAND_CHINA_PHONE_REGEX = /^1[3-9]\d{9}$/;

/**
 * 前端与后端保持同一归一化规则，避免展示值和提交值不一致。
 */
export function normalizePhoneNumber(raw: string): string {
  const trimmed = raw.trim().replace(/[()\s-]/g, '');
  if (trimmed.startsWith('+86')) {
    return trimmed.slice(3);
  }
  if (trimmed.startsWith('86') && trimmed.length === 13) {
    return trimmed.slice(2);
  }
  return trimmed;
}

export function isValidMainlandChinaPhone(phone: string): boolean {
  return MAINLAND_CHINA_PHONE_REGEX.test(phone);
}
