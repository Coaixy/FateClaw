import type { UserDto } from '@fateclaw/contracts/auth';

import type { User } from '../shared/types.js';

/**
 * 将宿主内部用户模型映射为对外稳定 DTO。
 * 明确裁掉密码哈希等内部字段，避免 route 层手写解构。
 */
export function toUserDto(user: User): UserDto {
  return {
    id: user.id,
    phone: user.phone,
    phone_verified: user.phone_verified,
    role: user.role,
    purchased_coins: user.purchased_coins,
    bonus_coins: user.bonus_coins,
    reserved_coins: user.reserved_coins,
    created_at: user.created_at,
  };
}
