import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCreateUser, mockGetUserByPhone } = vi.hoisted(() => ({
  mockCreateUser: vi.fn(),
  mockGetUserByPhone: vi.fn(),
}));

vi.mock('../../infrastructure/db.js', () => ({
  createUser: mockCreateUser,
  getUserByPhone: mockGetUserByPhone,
}));

import { createAdminUser } from './admin-service.js';

describe('createAdminUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserByPhone.mockResolvedValue(undefined);
    mockCreateUser.mockResolvedValue(undefined);
  });

  it('normalizes phone and persists a hashed admin-created user', async () => {
    const result = await createAdminUser({
      phone: '+86 138-0013-8000',
      password: 'initial-password',
      role: 'creator',
      phoneVerified: true,
    });

    expect(result.id).toEqual(expect.any(String));
    expect(mockGetUserByPhone).toHaveBeenCalledWith('13800138000');
    expect(mockCreateUser).toHaveBeenCalledWith(
      expect.objectContaining({
        id: result.id,
        phone: '13800138000',
        phone_verified: true,
        role: 'creator',
        purchased_cents: 0,
        bonus_cents: 0,
        earned_cents: 0,
        reserved_cents: 0,
        pending_withdrawal_cents: 0,
      }),
    );
    const created = mockCreateUser.mock.calls[0]?.[0];
    expect(created.password_hash).not.toBe('initial-password');
    expect(created.password_hash).toEqual(expect.stringMatching(/^\$2/));
  });

  it('rejects duplicate phones before hashing', async () => {
    mockGetUserByPhone.mockResolvedValue({ id: 'existing-user' });

    await expect(
      createAdminUser({
        phone: '13800138000',
        password: 'initial-password',
        role: 'consumer',
        phoneVerified: true,
      }),
    ).rejects.toThrow('该手机号已存在');

    expect(mockCreateUser).not.toHaveBeenCalled();
  });
});
