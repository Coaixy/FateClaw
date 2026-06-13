import { beforeEach, describe, expect, it, vi } from 'vitest';

import { announcementsApi } from '@/features/announcements/api';
import { requestJson } from '@/lib/http/client';

vi.mock('@/lib/http/client', () => ({
  requestJson: vi.fn(),
}));

const requestJsonMock = vi.mocked(requestJson);

describe('announcementsApi', () => {
  beforeEach(() => {
    requestJsonMock.mockReset();
    requestJsonMock.mockResolvedValue({});
  });

  it('loads the active announcement', async () => {
    await announcementsApi.active();

    expect(requestJsonMock).toHaveBeenCalledWith(
      '/api/public/announcements/active',
    );
  });

  it('loads the public announcement list', async () => {
    await announcementsApi.list();

    expect(requestJsonMock).toHaveBeenCalledWith('/api/public/announcements');
  });

  it('encodes announcement slugs in detail paths', async () => {
    await announcementsApi.detail('release/notes?x=1');

    expect(requestJsonMock).toHaveBeenCalledWith(
      '/api/public/announcements/release%2Fnotes%3Fx%3D1',
    );
  });
});
