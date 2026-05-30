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
    purchased_cents: user.purchased_cents,
    bonus_cents: user.bonus_cents,
    reserved_cents: user.reserved_cents,
    created_at: user.created_at,
  };
}
