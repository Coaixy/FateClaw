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

import { shouldClearChatSelection } from './use-chat-sessions';

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
