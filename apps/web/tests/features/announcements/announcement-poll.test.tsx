// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnnouncementPollDto } from '@fateclaw/contracts';

vi.mock('@/features/auth/hooks/use-auth', () => ({
  useAuth: () => ({ user: { id: 'voter-a' }, loading: false }),
}));
vi.mock('@/features/announcements/api', () => ({
  announcementsApi: { vote: vi.fn() },
}));

import { AnnouncementPoll } from '@/components/announcements/announcement-poll';
import { announcementsApi } from '@/features/announcements/api';

const poll: AnnouncementPollDto = {
  question: '下一步更新',
  allow_multiple: true,
  options: [
    { id: 'option-a', label: '体验', vote_count: 0 },
    { id: 'option-b', label: '功能', vote_count: 0 },
    { id: 'option-c', label: '文档', vote_count: 0 },
  ],
  closes_at: null,
  is_closed: false,
  total_votes: 0,
  selected_option_ids: [],
};

function Harness({ initial }: { initial: AnnouncementPollDto }) {
  const [current, setCurrent] = useState(initial);
  return (
    <AnnouncementPoll
      announcementId="notice"
      revision={1}
      poll={current}
      onChange={setCurrent}
      onRefresh={async () => {}}
    />
  );
}

describe('announcement poll selection', () => {
  let root: Root;
  let container: HTMLDivElement;

  const inputs = () => [...container.querySelectorAll('input')];
  const submitButton = () => container.querySelector('button')!;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('saves two choices and restores both from the persisted result', async () => {
    const saved: AnnouncementPollDto = {
      ...poll,
      selected_option_ids: ['option-b', 'option-a'],
      total_votes: 1,
      options: poll.options.map((option) => ({
        ...option,
        vote_count: option.id === 'option-c' ? 0 : 1,
      })),
    };
    vi.mocked(announcementsApi.vote).mockResolvedValue(saved);
    await act(async () => root.render(<Harness initial={poll} />));
    expect(inputs().map((input) => input.type)).toEqual([
      'checkbox',
      'checkbox',
      'checkbox',
    ]);
    expect(submitButton().disabled).toBe(true);
    await act(async () => inputs()[0].click());
    await act(async () => inputs()[1].click());
    expect(inputs().map((input) => input.checked)).toEqual([true, true, false]);
    await act(async () => submitButton().click());
    expect(announcementsApi.vote).toHaveBeenCalledWith(
      'notice',
      ['option-a', 'option-b'],
      1,
      expect.any(AbortSignal),
    );
    expect(submitButton().disabled).toBe(true);
    expect(container.textContent).toContain('1 人参与');
    expect(container.textContent).toContain('百分比按参与人数计算');
    expect(container.querySelectorAll('label')[0].textContent).toContain('100%');
    expect(container.querySelectorAll('label')[1].textContent).toContain('100%');

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<Harness initial={saved} />));
    expect(inputs().map((input) => input.checked)).toEqual([true, true, false]);
    expect(submitButton().disabled).toBe(true);
  });

  it('compares choices as a set, rejects an empty set, and replaces all saved choices', async () => {
    const initial: AnnouncementPollDto = {
      ...poll,
      total_votes: 1,
      selected_option_ids: ['option-a', 'option-b'],
    };
    const saved: AnnouncementPollDto = {
      ...initial,
      selected_option_ids: ['option-b', 'option-c'],
    };
    vi.mocked(announcementsApi.vote).mockResolvedValue(saved);
    await act(async () => root.render(<Harness initial={initial} />));
    await act(async () => inputs()[0].click());
    await act(async () => inputs()[0].click());
    expect(submitButton().disabled).toBe(true);
    await act(async () => inputs()[0].click());
    await act(async () => inputs()[1].click());
    expect(inputs().every((input) => !input.checked)).toBe(true);
    expect(submitButton().disabled).toBe(true);
    expect(announcementsApi.vote).not.toHaveBeenCalled();

    await act(async () => inputs()[1].click());
    await act(async () => inputs()[2].click());
    expect(submitButton().disabled).toBe(false);
    await act(async () => submitButton().click());
    expect(announcementsApi.vote).toHaveBeenCalledWith(
      'notice',
      ['option-b', 'option-c'],
      1,
      expect.any(AbortSignal),
    );
    expect(inputs().map((input) => input.checked)).toEqual([false, true, true]);
    expect(submitButton().disabled).toBe(true);
  });

  it('preserves unsaved choices when a refresh reorders the saved selection', async () => {
    const initial: AnnouncementPollDto = {
      ...poll,
      selected_option_ids: ['option-a', 'option-b'],
    };
    async function render(current: AnnouncementPollDto) {
      await act(async () =>
        root.render(
          <AnnouncementPoll
            announcementId="notice"
            revision={1}
            poll={current}
            onChange={() => {}}
            onRefresh={async () => {}}
          />,
        ),
      );
    }
    await render(initial);
    await act(async () => inputs()[0].click());
    await render({ ...initial, selected_option_ids: ['option-b', 'option-a'] });
    expect(inputs().map((input) => input.checked)).toEqual([false, true, false]);
    expect(submitButton().disabled).toBe(false);

    await render({ ...initial, selected_option_ids: ['option-c'] });
    expect(inputs().map((input) => input.checked)).toEqual([false, false, true]);
    expect(submitButton().disabled).toBe(true);
  });

  it('keeps single-choice polls exclusive and submits a one-choice array', async () => {
    const single = { ...poll, allow_multiple: false };
    vi.mocked(announcementsApi.vote).mockResolvedValue({
      ...single,
      selected_option_ids: ['option-b'],
    });
    await act(async () => root.render(<Harness initial={single} />));
    expect(inputs().every((input) => input.type === 'radio')).toBe(true);
    await act(async () => inputs()[0].click());
    await act(async () => inputs()[1].click());
    expect(inputs().map((input) => input.checked)).toEqual([false, true, false]);
    await act(async () => submitButton().click());
    expect(announcementsApi.vote).toHaveBeenCalledWith(
      'notice',
      ['option-b'],
      1,
      expect.any(AbortSignal),
    );
  });
});
