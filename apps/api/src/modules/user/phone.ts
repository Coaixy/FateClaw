const MAINLAND_CHINA_PHONE_REGEX = /^1[3-9]\d{9}$/;

/**
 * 归一化手机号输入：
 * - 去掉空格、短横线、括号等分隔符
 * - 接受 +86 / 86 前缀
 * - 入库统一保存为 11 位中国大陆手机号
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
