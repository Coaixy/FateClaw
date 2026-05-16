import { beforeEach, describe, expect, it, vi } from 'vitest';

import { skillsApi, SYSTEM_PAIPAN_CATEGORIES } from './api';

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

  it('keeps the guided paipan category list limited to system-supported types', () => {
    expect(SYSTEM_PAIPAN_CATEGORIES).toEqual([
      '八字',
      '紫微',
      '六爻',
      '经占',
      '奇门',
    ]);
  });

  it('unsubscribes a bundle subscription by bundle id', async () => {
    await skillsApi.bundleUnsubscribe('bundle 1');

    expect(requestJsonMock).toHaveBeenCalledWith(
      '/api/skills/bundles/subscriptions/bundle%201',
      { method: 'DELETE' },
    );
  });
});
