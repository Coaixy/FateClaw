import { describe, expect, it, vi } from 'vitest';

vi.mock('@/features/chat/api', () => ({
  chatSessionsApi: {},
}));

vi.mock('@/features/auth/hooks/use-auth', () => ({
  useAuth: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: vi.fn(),
  useRouter: vi.fn(),
}));

import {
  isAiChatPath,
  shouldClearChatSelection,
} from '../../../../features/chat/hooks/use-chat-sessions';

describe('shouldClearChatSelection', () => {
  it('keeps the selected session while auth is still loading', () => {
    expect(
      shouldClearChatSelection({
        user: null,
        authLoading: true,
        hasToken: false,
      }),
    ).toBe(false);
  });

  it('clears the selected session only after auth confirms no user and no token', () => {
    expect(
      shouldClearChatSelection({
        user: null,
        authLoading: false,
        hasToken: false,
      }),
    ).toBe(true);
  });

  it('keeps the selected session when a token still exists', () => {
    expect(
      shouldClearChatSelection({
        user: null,
        authLoading: false,
        hasToken: true,
      }),
    ).toBe(false);
  });

  it('keeps the selected session for authenticated users', () => {
    expect(
      shouldClearChatSelection({
        user: { id: 'user-1' },
        authLoading: false,
        hasToken: false,
      }),
    ).toBe(false);
  });
});

describe('isAiChatPath', () => {
  // 开发环境 usePathname 返回不带尾斜杠。
  it('matches the dev pathname without trailing slash', () => {
    expect(isAiChatPath('/ai-chat')).toBe(true);
  });

  // 生产 trailingSlash:true 下 usePathname 返回带尾斜杠，必须同样命中，
  // 否则聊天页内的会话切换/新建会误走 router.push 导致「新建却进上一个对话」。
  it('matches the production pathname with trailing slash', () => {
    expect(isAiChatPath('/ai-chat/')).toBe(true);
  });

  it('matches the root route because it renders the same chat workspace', () => {
    expect(isAiChatPath('/')).toBe(true);
  });

  it('does not match other routes or sub-paths', () => {
    expect(isAiChatPath('/ai-chat/share')).toBe(false);
    expect(isAiChatPath('/ai-chat/archive')).toBe(false);
    expect(isAiChatPath(null)).toBe(false);
    expect(isAiChatPath(undefined)).toBe(false);
  });
});
