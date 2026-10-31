// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnnouncementDto, AnnouncementPollDto } from '@fateclaw/contracts';

const auth = vi.hoisted(() => ({ user: { id: 'voter-a' }, loading: false }));
vi.mock('@/features/auth/hooks/use-auth', () => ({ useAuth: () => auth }));
vi.mock('next/navigation', () => ({ usePathname: () => '/announcements' }));
vi.mock('@/features/announcements/api', () => ({
  announcementsApi: { list: vi.fn() },
}));

import { announcementsApi } from '@/features/announcements/api';
import { useAnnouncements } from '@/features/announcements/use-announcements';

function deferred() {
  let resolve!: (value: { items: AnnouncementDto[] }) => void;
  const promise = new Promise<{ items: AnnouncementDto[] }>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const poll: AnnouncementPollDto = {
  question: '下一步更新',
  allow_multiple: false,
  options: [
    { id: 'option-a', label: '体验', vote_count: 0 },
    { id: 'option-b', label: '功能', vote_count: 0 },
  ],
  closes_at: null,
  is_closed: false,
  total_votes: 0,
  selected_option_ids: [],
};
const announcement: AnnouncementDto = {
  id: 'notice',
  title: '更新',
  body_markdown: '内容',
  revision: 1,
  published_at: '2026-10-31T00:00:00.000Z',
  poll,
};

describe('announcement result ownership', () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: ReturnType<typeof useAnnouncements>;
  function Harness() {
    current = useAnnouncements();
    return (
      <span>{current.items[0]?.poll?.selected_option_ids.join(',') || 'none'}</span>
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    auth.user = { id: 'voter-a' };
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('hides the previous account selection immediately and ignores its late response', async () => {
    const oldRead = deferred();
    const lateRead = deferred();
    const nextRead = deferred();
    vi.mocked(announcementsApi.list)
      .mockReturnValueOnce(oldRead.promise)
      .mockReturnValueOnce(lateRead.promise)
      .mockReturnValueOnce(nextRead.promise);
    await act(async () => root.render(<Harness />));
    await act(async () =>
      oldRead.resolve({
        items: [
          {
            ...announcement,
            poll: { ...poll, selected_option_ids: ['option-a'] },
          },
        ],
      }),
    );
    expect(container.textContent).toBe('option-a');
    await act(async () => {
      void current.refresh();
    });
    auth.user = { id: 'voter-b' };
    await act(async () => root.render(<Harness />));
    expect(current.items).toEqual([]);
    await act(async () =>
      lateRead.resolve({
        items: [
          {
            ...announcement,
            poll: { ...poll, selected_option_ids: ['option-a'] },
          },
        ],
      }),
    );
    expect(current.items).toEqual([]);
    await act(async () =>
      nextRead.resolve({
        items: [
          {
            ...announcement,
            poll: { ...poll, selected_option_ids: ['option-b'] },
          },
        ],
      }),
    );
    expect(container.textContent).toBe('option-b');
  });

  it('keeps a confirmed vote when an earlier list refresh finishes afterward', async () => {
    const initial = deferred();
    const stale = deferred();
    vi.mocked(announcementsApi.list)
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(stale.promise);
    await act(async () => root.render(<Harness />));
    await act(async () => initial.resolve({ items: [announcement] }));
    await act(async () => {
      void current.refresh();
    });
    await act(async () =>
      current.updatePoll('notice', {
        ...poll,
        total_votes: 1,
        selected_option_ids: ['option-b'],
        options: [poll.options[0], { ...poll.options[1], vote_count: 1 }],
      }),
    );
    await act(async () => stale.resolve({ items: [announcement] }));
    expect(current.items[0].poll).toMatchObject({
      total_votes: 1,
      selected_option_ids: ['option-b'],
    });
    expect(container.textContent).toBe('option-b');
    expect(current.loading).toBe(false);
  });
});
