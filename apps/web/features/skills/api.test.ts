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

describe('skillsApi path parameters', () => {
  beforeEach(() => {
    requestJsonMock.mockReset();
    requestJsonMock.mockResolvedValue({});
  });

  it('encodes user skill ids before placing them in path segments', async () => {
    await skillsApi.share('skill/../1?x=1');

    expect(requestJsonMock).toHaveBeenCalledWith(
      '/api/skills/user/skill%2F..%2F1%3Fx%3D1/share',
      { method: 'POST' },
    );
  });

  it('encodes shared skill tokens before placing them in path segments', async () => {
    await skillsApi.subscribe('share/token?x=1');

    expect(requestJsonMock).toHaveBeenCalledWith(
      '/api/skills/subscribe/share%2Ftoken%3Fx%3D1',
      { method: 'POST' },
    );
  });

  it('encodes shared bundle tokens before placing them in path segments', async () => {
    await skillsApi.bundlePreview('bundle/token?x=1');

    expect(requestJsonMock).toHaveBeenCalledWith(
      '/api/skills/bundles/shared/bundle%2Ftoken%3Fx%3D1',
    );
  });

  it('creates access invites without billing fields', async () => {
    await skillsApi.accessInviteCreate({
      target_type: 'skill',
      target_id: 'skill 1',
    });

    expect(requestJsonMock).toHaveBeenCalledWith('/api/skills/access-invites', {
      method: 'POST',
      body: JSON.stringify({
        target_type: 'skill',
        target_id: 'skill 1',
      }),
    });
  });

  it('encodes access invite tokens before previewing and redeeming', async () => {
    await skillsApi.accessInvitePreview('invite/token?x=1');
    await skillsApi.accessInviteRedeem('invite/token?x=1');

    expect(requestJsonMock).toHaveBeenNthCalledWith(
      1,
      '/api/skills/access-invites/invite%2Ftoken%3Fx%3D1',
    );
    expect(requestJsonMock).toHaveBeenNthCalledWith(
      2,
      '/api/skills/access-invites/invite%2Ftoken%3Fx%3D1/redeem',
      { method: 'POST' },
    );
  });
});
