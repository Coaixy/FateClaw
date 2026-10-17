import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

describe('announcement dismissal', () => {
  let values: Map<string, string>;
  beforeEach(() => {
    vi.resetModules();
    values = new Map();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('persists the dismissed version across page reloads and shows republished content', async () => {
    const { dismissAnnouncement } =
      await import('@/features/announcements/dismissal');
    dismissAnnouncement({ id: 'first', revision: 1 });
    vi.resetModules();
    const { isAnnouncementDismissed } =
      await import('@/features/announcements/dismissal');
    expect(isAnnouncementDismissed({ id: 'first', revision: 1 })).toBe(true);
    expect(isAnnouncementDismissed({ id: 'first', revision: 2 })).toBe(false);
    expect(isAnnouncementDismissed({ id: 'second', revision: 1 })).toBe(false);
  });

  it('still dismisses within the current session when local storage is blocked', async () => {
    vi.stubGlobal('window', {
      get localStorage() {
        throw new DOMException('Blocked', 'SecurityError');
      },
    });
    const { isAnnouncementDismissed, dismissAnnouncement } =
      await import('@/features/announcements/dismissal');
    const item = { id: 'first', revision: 1 };
    expect(isAnnouncementDismissed(item)).toBe(false);
    dismissAnnouncement(item);
    expect(isAnnouncementDismissed(item)).toBe(true);
    expect(isAnnouncementDismissed({ ...item, revision: 2 })).toBe(false);
  });
});
