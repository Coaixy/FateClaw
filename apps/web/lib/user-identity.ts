export function getUserIdentityLabel(input: { phone?: string | null }): string {
  return input.phone || '未绑定手机号';
}
