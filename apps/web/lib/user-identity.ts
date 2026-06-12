import type { Locale } from '@/lib/i18n';

/**
 * 生成用户身份兜底展示文案。
 *
 * @param input 用户身份字段。
 * @param locale 当前前端展示语言；缺省时保持简中旧行为。
 * @returns 可直接展示在用户菜单里的身份文案。
 */
export function getUserIdentityLabel(
  input: { phone?: string | null },
  locale?: Locale,
): string {
  if (input.phone) {
    return input.phone;
  }

  if (locale === 'en') {
    return 'No phone linked';
  }

  return locale === 'zh-TW' ? '未綁定手機號' : '未绑定手机号';
}
