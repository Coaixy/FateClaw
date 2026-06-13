import { describe, expect, it } from 'vitest';

import {
  dismissAnnouncement,
  getAnnouncementDismissKey,
  isAnnouncementDismissed,
} from '@/components/announcements/announcement-dismissal';

function createMemoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  } satisfies Pick<Storage, 'getItem' | 'setItem'>;
}

describe('announcement dismissal helpers', () => {
  it('uses announcement id and updated_at in the dismissal key', () => {
    expect(
      getAnnouncementDismissKey({
        id: 'announcement-1',
        updated_at: '2026-06-12T08:00:00.000Z',
      }),
    ).toBe(
      'fateclaw:announcement:dismissed:announcement-1:2026-06-12T08:00:00.000Z',
    );
  });

  it('hides only the dismissed announcement version', () => {
    const storage = createMemoryStorage();
    const announcement = {
      id: 'announcement-1',
      updated_at: '2026-06-12T08:00:00.000Z',
    };

    expect(isAnnouncementDismissed(storage, announcement)).toBe(false);
    expect(dismissAnnouncement(storage, announcement)).toBe(true);
    expect(isAnnouncementDismissed(storage, announcement)).toBe(true);
    expect(
      isAnnouncementDismissed(storage, {
        ...announcement,
        updated_at: '2026-06-12T09:00:00.000Z',
      }),
    ).toBe(false);
  });
});
