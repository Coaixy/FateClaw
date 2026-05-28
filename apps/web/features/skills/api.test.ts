import { beforeEach, describe, expect, it, vi } from 'vitest';

import { skillsApi } from './api';

import { requestJson } from '@/lib/http/client';

vi.mock('@/lib/http/client', () => ({
  requestJson: vi.fn(),
}));

const requestJsonMock = vi.mocked(requestJson);

describe('skillsApi bundle subscriptions', () => {
  beforeEach(() => {
    requestJsonMock.mockReset();
    requestJsonMock.mockResolvedValue({ unsubscribed_count: 2 });
  });

  it('unsubscribes a bundle subscription by bundle id', async () => {
    await skillsApi.bundleUnsubscribe('bundle 1');

    expect(requestJsonMock).toHaveBeenCalledWith(
      '/api/skills/bundles/subscriptions/bundle%201',
      { method: 'DELETE' },
    );
  });
});
