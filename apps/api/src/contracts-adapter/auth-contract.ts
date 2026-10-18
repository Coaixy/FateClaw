import type { UserDto } from '@fateclaw/contracts/auth';

import type { User } from '#shared/types';
import { maskPhoneNumber } from '#modules/user/phone';

/**
 * 将宿主内部用户模型映射为对外稳定 DTO。
 * 明确裁掉密码哈希等内部字段，避免 route 层手写解构。
 * 普通用户态只暴露脱敏手机号，完整手机号仅留在后端认证域内部使用。
 */
export function toUserDto(user: User): UserDto {
  const phoneMasked = user.phone ? maskPhoneNumber(user.phone) : null;
  return {
    id: user.id,
    phone: phoneMasked,
    phone_masked: phoneMasked,
    phone_verified: user.phone_verified,
    has_password: Boolean(user.password_hash),
    role: user.role,
    purchased_coins: user.purchased_coins,
    bonus_coins: user.bonus_coins,
    reserved_coins: user.reserved_coins,
    created_at: user.created_at,
  };
}
