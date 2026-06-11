import { beforeEach, describe, expect, it, vi } from 'vitest';

import { referralsApi } from '../../../features/referrals/api';

import { requestJson } from '@/lib/http/client';

vi.mock('@/lib/http/client', () => ({
  requestJson: vi.fn(),
}));

const requestJsonMock = vi.mocked(requestJson);

describe('referralsApi', () => {
  beforeEach(() => {
    requestJsonMock.mockReset();
    requestJsonMock.mockResolvedValue({});
  });

  it('encodes invite codes in path segments', async () => {
    await referralsApi.preview('code/token?x=1');
    await referralsApi.redeem('code/token?x=1');

    expect(requestJsonMock).toHaveBeenNthCalledWith(
      1,
      '/api/referrals/invites/code%2Ftoken%3Fx%3D1/preview',
    );
    expect(requestJsonMock).toHaveBeenNthCalledWith(
      2,
      '/api/referrals/invites/code%2Ftoken%3Fx%3D1/redeem',
      { method: 'POST' },
    );
  });

  it('loads current user referral summary', async () => {
    await referralsApi.me();

    expect(requestJsonMock).toHaveBeenCalledWith('/api/referrals/me');
  });
});
