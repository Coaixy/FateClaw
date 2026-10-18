import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetUserSoulContent } = vi.hoisted(() => ({
  mockGetUserSoulContent: vi.fn(),
}));

vi.mock('#infrastructure/db', () => ({
  getUserSoulContent: mockGetUserSoulContent,
}));

import { buildStructuredInputForSession } from '#modules/chat/structured-input';

const identity = {
  runtimeId: 'web:user-1',
  userName: '命主',
  assistantName: '命枢',
  soulUserId: 'user-1',
};

describe('buildStructuredInputForSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserSoulContent.mockResolvedValue('');
  });

  it('fills personaPrompt from the trimmed user soul when present', async () => {
    mockGetUserSoulContent.mockResolvedValue('  严厉直断的六爻老法师  ');

    const result = await buildStructuredInputForSession(
      identity,
      '请解读这张盘',
      'session-1',
      'gpt-4.1',
      128_000,
    );

    expect(mockGetUserSoulContent).toHaveBeenCalledWith('user-1');
    expect(result.personaPrompt).toBe('严厉直断的六爻老法师');
  });

  it('leaves personaPrompt undefined when the soul is empty', async () => {
    mockGetUserSoulContent.mockResolvedValue('   ');

    const result = await buildStructuredInputForSession(
      identity,
      '请解读这张盘',
      'session-1',
      'gpt-4.1',
      128_000,
    );

    expect(result.personaPrompt).toBeUndefined();
  });

  it('does not read the soul when soulUserId is absent', async () => {
    const result = await buildStructuredInputForSession(
      {
        runtimeId: 'web:user-1',
        userName: '命主',
        assistantName: '命枢',
      },
      '请解读这张盘',
      'session-1',
      'gpt-4.1',
      128_000,
    );

    expect(mockGetUserSoulContent).not.toHaveBeenCalled();
    expect(result.personaPrompt).toBeUndefined();
  });
});
