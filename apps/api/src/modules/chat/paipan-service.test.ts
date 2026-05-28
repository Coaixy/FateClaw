import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCreateChatSession,
  mockStoreMessage,
  mockTouchChatSession,
  mockRedisGet,
  mockRedisDel,
} = vi.hoisted(() => ({
  mockCreateChatSession: vi.fn(),
  mockStoreMessage: vi.fn(),
  mockTouchChatSession: vi.fn(),
  mockRedisGet: vi.fn(),
  mockRedisDel: vi.fn(),
}));

vi.mock('../../infrastructure/db.js', () => ({
  createChatSession: mockCreateChatSession,
  getChatSession: vi.fn(),
  storeMessage: mockStoreMessage,
  touchChatSession: mockTouchChatSession,
}));

vi.mock('../../infrastructure/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../infrastructure/redis.js', () => ({
  getRedis: vi.fn(() => ({
    get: mockRedisGet,
    del: mockRedisDel,
  })),
}));

vi.mock('./paipan-runtime.js', () => ({
  DirectPaipanError: class DirectPaipanError extends Error {
    constructor(
      public code: string,
      message: string,
      public statusCode: number,
    ) {
      super(message);
    }
  },
  executeDirectPaipan: vi.fn(),
  listDirectPaipanCatalog: vi.fn(),
}));

import { commitDirectPaipanForOwnedUser } from './paipan-service.js';

describe('commitDirectPaipanForOwnedUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateChatSession.mockImplementation(
      async (session: {
        id: string;
        accountId: string;
        userId: string;
        title: string;
      }) => ({
        id: session.id,
        account_id: session.accountId,
        user_id: session.userId,
        title: session.title,
        created_at: '2026-05-09T00:00:00.000Z',
        updated_at: '2026-05-09T00:00:00.000Z',
        deleted_at: null,
      }),
    );
    mockStoreMessage.mockResolvedValue(undefined);
    mockTouchChatSession.mockResolvedValue(undefined);
    mockRedisDel.mockResolvedValue(1);
  });

  it('keeps the board type and appends the latest note when committing a preview', async () => {
    mockRedisGet.mockResolvedValue(
      JSON.stringify({
        previewId: 'preview-1',
        userId: 'user-1',
        runtimeId: 'web:user-1',
        skill: 'iching-paipan',
        requestSummary: '六爻排盘',
        sessionTitle: '六爻排盘',
        skillContextEntry: {
          skill: 'iching-paipan',
          output: '六爻排盘（系统排盘结果）\nok：true',
          artifactType: 'skill.iching-paipan',
          artifactTitle: '六爻排盘',
          artifactData: { ok: true },
        },
        createdAt: '2026-05-09T00:00:00.000Z',
        expiresAt: '2026-05-09T00:30:00.000Z',
      }),
    );

    const result = await commitDirectPaipanForOwnedUser('user-1', {
      target: 'new_session_from_preview',
      previewId: 'preview-1',
      displayNote: '  感情  ',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.session.title).toBe('六爻排盘 · 感情');
    expect(result.data.requestMessage.content).toBe('六爻排盘 · 感情');
    expect(result.data.resultMessage.content).toBe('已生成：六爻排盘 · 感情');
    expect(JSON.parse(result.data.resultMessage.tool_context || '[]')).toEqual([
      expect.objectContaining({
        artifactTitle: '六爻排盘 · 感情',
      }),
    ]);
  });
});
