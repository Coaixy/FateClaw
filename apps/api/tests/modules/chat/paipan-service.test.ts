import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { createDirectPaipanFromPreview } from '#infrastructure/repositories/direct-paipan-repository';

vi.mock('#infrastructure/repositories/benefit-repository', () => ({
  getPreferredModelPool: async () => 'official',
}));

const {
  mockCreateFromPreview,
  mockFindCommit,
  mockAppendToSession,
  mockGetChatSession,
  mockRedisGet,
  mockRedisSet,
  mockRedisDel,
  mockExecuteDirectPaipan,
} = vi.hoisted(() => ({
  mockCreateFromPreview: vi.fn<typeof createDirectPaipanFromPreview>(),
  mockFindCommit: vi.fn(),
  mockAppendToSession: vi.fn(),
  mockGetChatSession: vi.fn(),
  mockRedisGet: vi.fn(),
  mockRedisSet: vi.fn(),
  mockRedisDel: vi.fn(),
  mockExecuteDirectPaipan: vi.fn(),
}));

vi.mock('#infrastructure/db', () => ({
  getChatSession: mockGetChatSession,
}));

vi.mock('#infrastructure/repositories/direct-paipan-repository', () => ({
  appendDirectPaipanToSession: mockAppendToSession,
  createDirectPaipanFromPreview: mockCreateFromPreview,
  findDirectPaipanCommit: mockFindCommit,
}));

vi.mock('#infrastructure/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('#infrastructure/redis', () => ({
  getRedis: vi.fn(() => ({
    get: mockRedisGet,
    set: mockRedisSet,
    del: mockRedisDel,
  })),
}));

vi.mock('#modules/chat/paipan-runtime', () => ({
  DirectPaipanError: class DirectPaipanError extends Error {
    constructor(
      public code: string,
      message: string,
      public statusCode: number,
    ) {
      super(message);
    }
  },
  executeDirectPaipan: mockExecuteDirectPaipan,
  listDirectPaipanCatalog: vi.fn(),
}));

import {
  commitDirectPaipanForOwnedUser,
  previewDirectPaipanForOwnedUser,
} from '#modules/chat/paipan-service';

const previewId = '00000000-0000-4000-8000-000000000001';
const previewCommit = {
  target: 'new_session_from_preview',
  previewId,
} as const;
const chart = {
  skill: { dir: 'iching-paipan' },
  requestSummary: '六爻排盘',
  sessionTitle: '六爻排盘',
  skillContextEntry: {
    skill: 'iching-paipan',
    output: '六爻排盘（系统排盘结果）\nok：true',
    artifactType: 'skill.iching-paipan',
    artifactTitle: '六爻排盘',
    artifactData: { ok: true },
  },
};

function previewRecord(userId: string | null) {
  return JSON.stringify({
    ...chart,
    previewId,
    userId,
    runtimeId: `web:${userId ?? 'public-preview'}`,
    skill: 'iching-paipan',
    createdAt: '2026-05-09T00:00:00.000Z',
    expiresAt: '2026-05-09T00:30:00.000Z',
  });
}

describe('previewDirectPaipanForOwnedUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisSet.mockResolvedValue('OK');
    mockExecuteDirectPaipan.mockResolvedValue(chart);
  });

  it('stores previews for authenticated users', async () => {
    const result = await previewDirectPaipanForOwnedUser({
      userId: 'user-1',
      skill: 'iching-paipan',
      input: { topic: '测试' },
    });

    expect(result.ok).toBe(true);
    expect(mockExecuteDirectPaipan).toHaveBeenCalledWith({
      accountId: 'web:user-1',
      userId: 'user-1',
      skillDir: 'iching-paipan',
      input: { topic: '测试' },
    });
    expect(mockRedisSet).toHaveBeenCalledTimes(1);
    const [key, raw, px, ttl] = mockRedisSet.mock.calls[0];
    expect(key).toMatch(/^direct-paipan:preview:/);
    expect(px).toBe('PX');
    expect(ttl).toBe(30 * 60 * 1000);
    expect(JSON.parse(raw)).toEqual(
      expect.objectContaining({
        userId: 'user-1',
        runtimeId: 'web:user-1',
        skill: 'iching-paipan',
        requestSummary: '六爻排盘',
        sessionTitle: '六爻排盘',
      }),
    );
  });

  it('stores anonymous previews so they can be committed after login', async () => {
    const result = await previewDirectPaipanForOwnedUser({
      skill: 'iching-paipan',
      input: { topic: '测试' },
    });

    expect(result.ok).toBe(true);
    expect(mockExecuteDirectPaipan).toHaveBeenCalledWith({
      accountId: 'web:public-preview',
      userId: undefined,
      skillDir: 'iching-paipan',
      input: { topic: '测试' },
    });
    expect(mockRedisSet).toHaveBeenCalledTimes(1);
    const [, raw] = mockRedisSet.mock.calls[0];
    expect(JSON.parse(raw)).toEqual(
      expect.objectContaining({
        userId: null,
        runtimeId: 'web:public-preview',
      }),
    );
  });
});

describe('commitDirectPaipanForOwnedUser', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCreateFromPreview.mockImplementation(async ({ session, messages }) => ({
      status: 'saved',
      data: {
        ...messages,
        session: {
          id: session.id,
          account_id: session.accountId,
          user_id: session.userId,
          title: session.title,
          created_at: '2026-05-09T00:00:00.000Z',
          updated_at: '2026-05-09T00:00:00.000Z',
          deleted_at: null,
        },
      },
    }));
    mockFindCommit.mockResolvedValue(undefined);
    mockRedisGet.mockResolvedValue(null);
    mockRedisDel.mockResolvedValue(1);
    mockExecuteDirectPaipan.mockResolvedValue(chart);
  });

  it('keeps the board title when committing a preview', async () => {
    mockRedisGet.mockResolvedValue(previewRecord('user-1'));

    const result = await commitDirectPaipanForOwnedUser(
      'user-1',
      previewCommit,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.session.title).toBe('六爻排盘');
    expect(result.data.requestMessage.content).toBe('六爻排盘');
    expect(result.data.resultMessage.content).toBe(
      '已生成六爻排盘。你可以直接提问，后续未切换主题时会参考此盘面。',
    );
    expect(JSON.parse(result.data.resultMessage.tool_context || '[]')).toEqual([
      expect.objectContaining({
        artifactTitle: '六爻排盘',
      }),
    ]);
  });

  it('commits an anonymous preview into the authenticated user runtime', async () => {
    mockRedisGet.mockResolvedValue(previewRecord(null));

    const result = await commitDirectPaipanForOwnedUser(
      'user-1',
      previewCommit,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.session.account_id).toBe('web:user-1');
    expect(result.data.requestMessage.account_id).toBe('web:user-1');
    expect(result.data.resultMessage.account_id).toBe('web:user-1');
  });

  it('keeps a committed response successful when deleting the preview cache fails', async () => {
    mockRedisGet.mockResolvedValue(previewRecord('user-1'));
    mockRedisDel.mockRejectedValue(new Error('Redis unavailable'));
    const result = await commitDirectPaipanForOwnedUser(
      'user-1',
      previewCommit,
    );
    expect(result.ok).toBe(true);
    expect(mockCreateFromPreview).toHaveBeenCalledTimes(1);
  });

  it('rejects a preview committed or owned by a different user', async () => {
    mockRedisGet.mockResolvedValue(previewRecord('user-2'));
    await expect(
      commitDirectPaipanForOwnedUser('user-1', previewCommit),
    ).resolves.toMatchObject({ ok: false, statusCode: 403 });

    mockRedisGet.mockClear();
    mockFindCommit.mockResolvedValue({ status: 'forbidden' });
    await expect(
      commitDirectPaipanForOwnedUser('user-1', previewCommit),
    ).resolves.toMatchObject({ ok: false, statusCode: 403 });
    expect(mockRedisGet).not.toHaveBeenCalled();
    expect(mockCreateFromPreview).not.toHaveBeenCalled();
  });

  it('rechecks PostgreSQL if the preview disappears between receipt and Redis reads', async () => {
    mockFindCommit
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ status: 'forbidden' });
    await expect(
      commitDirectPaipanForOwnedUser('user-1', previewCommit),
    ).resolves.toMatchObject({ ok: false, statusCode: 403 });
    expect(mockFindCommit).toHaveBeenCalledTimes(2);
    expect(mockCreateFromPreview).not.toHaveBeenCalled();
  });

  it('returns a missing session if it was archived before the chart could be appended', async () => {
    mockGetChatSession.mockResolvedValue({
      id: 'session-1',
      user_id: 'user-1',
      account_id: 'web:user-1',
    });
    mockAppendToSession.mockResolvedValue({ status: 'missing' });

    await expect(
      commitDirectPaipanForOwnedUser('user-1', {
        target: 'current_session',
        sessionId: 'session-1',
        skill: 'iching-paipan',
        input: { topic: '测试' },
      }),
    ).resolves.toMatchObject({ ok: false, statusCode: 404 });
    expect(mockAppendToSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', userId: 'user-1' }),
    );
  });
});
