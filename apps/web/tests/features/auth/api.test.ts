import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authApi } from '../../../features/auth/api';

import { requestJson } from '@/lib/http/client';

vi.mock('@/lib/http/client', () => ({
  requestJson: vi.fn(),
}));

const requestJsonMock = vi.mocked(requestJson);

describe('authApi', () => {
  beforeEach(() => {
    requestJsonMock.mockReset();
    requestJsonMock.mockResolvedValue({});
  });

  it('passes optional invite code during registration', async () => {
    await authApi.register('13800138000', 'password123', '123456', 'ABC123');

    expect(requestJsonMock).toHaveBeenCalledWith('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        phoneNumber: '13800138000',
        password: 'password123',
        smsCaptchaCode: '123456',
        invite_code: 'ABC123',
      }),
    });
  });
});
