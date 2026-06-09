import { describe, expect, it } from 'vitest';

import { toUserDto } from '../../src/contracts-adapter/auth-contract.js';
import type { User } from '../../src/shared/types.js';

function user(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    phone: '13800138000',
    phone_verified: true,
    password_hash: 'hash',
    role: 'consumer',
    purchased_coins: 0,
    bonus_coins: 0,
    reserved_coins: 0,
    created_at: '2026-05-31T00:00:00.000Z',
    ...overrides,
  };
}

describe('toUserDto', () => {
  it('masks phone numbers in public auth responses', () => {
    const dto = toUserDto(user());

    expect(dto.phone).toBe('138****8000');
    expect(dto.phone_masked).toBe('138****8000');
    expect(JSON.stringify(dto)).not.toContain('13800138000');
  });
});
