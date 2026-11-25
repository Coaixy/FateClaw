// @vitest-environment jsdom

import { act, type PropsWithChildren } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import HistoryPage from '@/app/history/page';
import { chatSessionsApi, type ChatSession } from '@/features/chat/api';
import { ChatSessionsProvider } from '@/features/chat/hooks/use-chat-sessions';
import { I18nProvider } from '@/lib/i18n';

const { toast, push } = vi.hoisted(() => ({ toast: vi.fn(), push: vi.fn() }));

vi.mock('@/components/app-shell', () => ({
  AppShell: ({ children }: PropsWithChildren) => (
    <ChatSessionsProvider>{children}</ChatSessionsProvider>
  ),
}));

vi.mock('@/components/ai-chat/session-share-dialog', () => ({
  SessionShareDialog: () => null,
}));

vi.mock('@/features/chat/api', () => ({
  chatSessionsApi: {
    readListSnapshot: vi.fn(),
    list: vi.fn(),
    archived: vi.fn(),
    archive: vi.fn(),
    restore: vi.fn(),
  },
}));

vi.mock('@/features/auth/hooks/use-auth', () => {
  const user = { id: 'synthetic-user' };
  return { useAuth: () => ({ user, loading: false }) };
});

vi.mock('@/features/chat/hooks/use-client-profiles', () => {
  const profiles: never[] = [];
  const loadProfiles = vi.fn();
  return { useClientProfiles: () => ({ profiles, loadProfiles }) };
});

vi.mock('@/lib/use-toast', () => ({
  useToast: () => ({ toast }),
}));

vi.mock('next/navigation', () => {
  const router = { push };
  return { usePathname: () => '/history', useRouter: () => router };
});

const unlinked: ChatSession = {
  id: 'unlinked',
  account_id: 'web:synthetic-user',
  title: '没有关联客户的对话',
  created_at: '2026-10-28T00:00:00Z',
  updated_at: '2026-10-28T00:00:00Z',
  client_id: null,
  deleted_at: null,
};
const archived: ChatSession = {
  ...unlinked,
  deleted_at: '2026-10-29T00:00:00Z',
};
const second: ChatSession = {
  ...unlinked,
  id: 'second',
  title: '另一条对话',
};
const remaining: ChatSession = {
  ...unlinked,
  id: 'remaining',
  title: '保留的对话',
};

let root: Root;
let container: HTMLDivElement;

function button(label: string): HTMLButtonElement {
  const result = Array.from(container.querySelectorAll('button')).find(
    (item) =>
      item.textContent === label || item.getAttribute('aria-label') === label,
  );
  expect(result, `Missing button: ${label}`).toBeDefined();
  return result!;
}

async function click(label: string) {
  await act(async () => button(label).click());
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function mount(key = 'history') {
  await act(async () => {
    root.render(
      <I18nProvider locale="zh-CN">
        <HistoryPage key={key} />
      </I18nProvider>,
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.history.replaceState(null, '', '/history');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(chatSessionsApi.list).mockResolvedValue([unlinked]);
  vi.mocked(chatSessionsApi.archived).mockResolvedValue([archived]);
  vi.mocked(chatSessionsApi.archive).mockResolvedValue({ success: true });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('conversation archive management', () => {
  it('hides rows during concurrent requests and restores only the failed row in place', async () => {
    const firstArchive = deferred<{ success: true }>();
    const secondArchive = deferred<{ success: true }>();
    vi.mocked(chatSessionsApi.list).mockResolvedValue([
      unlinked,
      second,
      remaining,
    ]);
    vi.mocked(chatSessionsApi.archive)
      .mockReturnValueOnce(firstArchive.promise)
      .mockReturnValueOnce(secondArchive.promise);

    await mount();
    const firstButton = button('归档对话');
    await act(async () => {
      firstButton.click();
      firstButton.click();
    });
    expect(chatSessionsApi.archive).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain(unlinked.title);
    expect(container.textContent).toContain(second.title);

    await click('归档对话');
    expect(chatSessionsApi.archive).toHaveBeenNthCalledWith(2, second.id);
    expect(container.textContent).not.toContain(second.title);
    expect(container.textContent).toContain(remaining.title);
    expect(toast).not.toHaveBeenCalled();

    await act(async () => secondArchive.resolve({ success: true }));
    await act(async () => firstArchive.reject(new Error('归档暂时失败')));
    expect(container.textContent).toContain(unlinked.title);
    expect(container.textContent).not.toContain(second.title);
    expect(container.textContent!.indexOf(unlinked.title)).toBeLessThan(
      container.textContent!.indexOf(remaining.title),
    );
    expect(toast).toHaveBeenCalledWith('error', '归档暂时失败');
    expect(
      toast.mock.calls.filter(([type]) => type === 'success'),
    ).toHaveLength(1);

    await click('归档对话');
    expect(chatSessionsApi.archive).toHaveBeenNthCalledWith(3, unlinked.id);
    expect(container.textContent).not.toContain(unlinked.title);
  });

  it.each([true, false])(
    'keeps a row hidden across navigation when the stale list arrives before confirmation: %s',
    async (listArrivesFirst) => {
      const archive = deferred<{ success: true }>();
      const staleList = deferred<ChatSession[]>();
      vi.mocked(chatSessionsApi.archive).mockReturnValueOnce(archive.promise);
      await mount();
      await click('归档对话');
      vi.mocked(chatSessionsApi.list).mockReturnValueOnce(staleList.promise);
      await mount('after-navigation');

      async function receiveList() {
        await act(async () => staleList.resolve([unlinked, remaining]));
        expect(container.textContent).toContain(remaining.title);
        expect(container.textContent).not.toContain(unlinked.title);
      }

      if (listArrivesFirst) await receiveList();
      await act(async () => archive.resolve({ success: true }));
      if (!listArrivesFirst) await receiveList();
      expect(container.textContent).not.toContain(unlinked.title);
    },
  );

  it('leaves a newly opened conversation selected when an earlier archive completes', async () => {
    const archive = deferred<{ success: true }>();
    vi.mocked(chatSessionsApi.list).mockResolvedValue([unlinked, second]);
    vi.mocked(chatSessionsApi.archive).mockReturnValueOnce(archive.promise);
    window.history.replaceState(null, '', `/history?sid=${unlinked.id}`);
    await mount();
    await click('归档对话');

    const secondRow = container.querySelector<HTMLElement>('[role="button"]');
    expect(secondRow?.textContent).toContain(second.title);
    await act(async () => secondRow?.click());
    expect(push).toHaveBeenLastCalledWith(`/ai-chat?sid=${second.id}`);

    await act(async () => archive.resolve({ success: true }));
    expect(push).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'reconciles an open archive list after confirmation when the server lists the row early: %s',
    async (serverListsPendingArchive) => {
      const archive = deferred<{ success: true }>();
      const refreshedList = deferred<ChatSession[]>();
      const previouslyArchived = { ...second, deleted_at: archived.deleted_at };
      vi.mocked(chatSessionsApi.archive).mockReturnValueOnce(archive.promise);
      vi.mocked(chatSessionsApi.archived)
        .mockResolvedValueOnce(
          serverListsPendingArchive
            ? [previouslyArchived, archived]
            : [previouslyArchived],
        )
        .mockReturnValueOnce(refreshedList.promise);
      vi.mocked(chatSessionsApi.restore).mockResolvedValueOnce(second);
      await mount();
      await click('归档对话');
      await click('已归档');
      expect(container.textContent).toContain(second.title);
      expect(container.textContent).not.toContain(unlinked.title);

      await act(async () => archive.resolve({ success: true }));
      expect(chatSessionsApi.archived).toHaveBeenCalledTimes(2);
      await click('恢复');
      expect(chatSessionsApi.restore).toHaveBeenCalledWith(second.id);
      await act(async () =>
        refreshedList.resolve([archived, previouslyArchived]),
      );
      expect(container.textContent).toContain(unlinked.title);
      expect(container.textContent).not.toContain(second.title);

      await click('未归档');
      expect(container.textContent).toContain(second.title);
      expect(container.textContent).not.toContain(unlinked.title);
    },
  );

  it('finds an unlinked conversation after archiving and restores it to the active list without reloading', async () => {
    await mount();
    await click('归档对话');
    expect(container.textContent).not.toContain(unlinked.title);

    await click('已归档');
    expect(container.textContent).toContain(unlinked.title);
    expect(container.querySelector('[role="button"]')).toBeNull();

    vi.mocked(chatSessionsApi.restore).mockRejectedValueOnce(
      new Error('恢复暂时失败'),
    );
    await click('恢复');
    expect(container.textContent).toContain(unlinked.title);
    expect(button('恢复').disabled).toBe(false);

    const restore = deferred<ChatSession>();
    vi.mocked(chatSessionsApi.restore).mockReturnValueOnce(restore.promise);
    await click('恢复');
    expect(button('恢复中…').disabled).toBe(true);
    expect(button('未归档').disabled).toBe(true);
    await act(async () =>
      restore.resolve({ ...unlinked, updated_at: '2026-10-29T01:00:00Z' }),
    );
    expect(container.textContent).not.toContain(unlinked.title);

    await click('未归档');
    expect(container.textContent).toContain(unlinked.title);
    expect(vi.mocked(chatSessionsApi.list)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(chatSessionsApi.restore)).toHaveBeenLastCalledWith(
      unlinked.id,
    );
  });

  it('shows a failed archive query and supports retrying it', async () => {
    vi.mocked(chatSessionsApi.archived).mockRejectedValueOnce(
      new Error('归档查询暂时失败'),
    );
    await mount();
    await click('已归档');
    expect(container.textContent).toContain('归档查询暂时失败');
    expect(container.textContent).not.toContain('暂无归档对话');

    await click('重试');
    expect(container.textContent).toContain(unlinked.title);
    expect(vi.mocked(chatSessionsApi.archived)).toHaveBeenCalledTimes(2);
  });
});
