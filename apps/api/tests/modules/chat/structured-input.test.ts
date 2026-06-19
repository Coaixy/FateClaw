import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetUserSoulContent, mockGetUserGuashiScriptTemplate } = vi.hoisted(
  () => ({
    mockGetUserSoulContent: vi.fn(),
    mockGetUserGuashiScriptTemplate: vi.fn(),
  }),
);

vi.mock('../../../src/infrastructure/db.js', () => ({
  getUserSoulContent: mockGetUserSoulContent,
  getUserGuashiScriptTemplate: mockGetUserGuashiScriptTemplate,
}));

import { buildStructuredInputForSession } from '../../../src/modules/chat/structured-input.js';

const identity = {
  runtimeId: 'web:user-1',
  userName: '命主',
  assistantName: '命枢',
  soulUserId: 'user-1',
};

describe('buildStructuredInputForSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 默认 soul 与话术稿模板都为空,各用例按需覆盖;避免未配置 mock 返回 undefined 触发 .trim() 报错。
    mockGetUserSoulContent.mockResolvedValue('');
    mockGetUserGuashiScriptTemplate.mockResolvedValue('');
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

  it('fills guashiScriptTemplate from the trimmed template when present', async () => {
    mockGetUserGuashiScriptTemplate.mockResolvedValue(
      '  ## 我的核心结论\n## 我的建议  ',
    );

    const result = await buildStructuredInputForSession(
      identity,
      '请解读这张盘',
      'session-1',
      'gpt-4.1',
      128_000,
    );

    expect(mockGetUserGuashiScriptTemplate).toHaveBeenCalledWith('user-1');
    expect(result.guashiScriptTemplate).toBe('## 我的核心结论\n## 我的建议');
  });

  it('leaves guashiScriptTemplate undefined when the template is empty', async () => {
    mockGetUserGuashiScriptTemplate.mockResolvedValue('   ');

    const result = await buildStructuredInputForSession(
      identity,
      '请解读这张盘',
      'session-1',
      'gpt-4.1',
      128_000,
    );

    expect(result.guashiScriptTemplate).toBeUndefined();
  });

  it('does not read the template when soulUserId is absent', async () => {
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

    expect(mockGetUserGuashiScriptTemplate).not.toHaveBeenCalled();
    expect(result.guashiScriptTemplate).toBeUndefined();
  });
});
