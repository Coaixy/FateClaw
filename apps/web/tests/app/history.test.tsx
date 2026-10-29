// @vitest-environment jsdom

import { act, type PropsWithChildren } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import HistoryPage from '@/app/history/page';
import { chatSessionsApi, type ChatSession } from '@/features/chat/api';
import { ChatSessionsProvider } from '@/features/chat/hooks/use-chat-sessions';
import { I18nProvider } from '@/lib/i18n';

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
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock('next/navigation', () => {
  const router = { push: vi.fn() };
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

async function mount() {
  await act(async () => {
    root.render(
      <I18nProvider locale="zh-CN">
        <HistoryPage />
      </I18nProvider>,
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
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

    let resolve!: (session: ChatSession) => void;
    vi.mocked(chatSessionsApi.restore).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await click('恢复');
    expect(button('恢复中…').disabled).toBe(true);
    expect(button('未归档').disabled).toBe(true);
    await act(async () =>
      resolve({ ...unlinked, updated_at: '2026-10-29T01:00:00Z' }),
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
