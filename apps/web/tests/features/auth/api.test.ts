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

  it('registers without invite code in payload', async () => {
    // 邀请体系已从前端下线,注册请求不再携带 invite_code 字段。
    await authApi.register('13800138000', 'password123', '123456');

    expect(requestJsonMock).toHaveBeenCalledWith('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        phoneNumber: '13800138000',
        password: 'password123',
        smsCaptchaCode: '123456',
      }),
    });
  });
});
