import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCreateChatSession,
  mockStoreMessage,
  mockTouchChatSession,
  mockRedisGet,
  mockRedisSet,
  mockRedisDel,
  mockExecuteDirectPaipan,
} = vi.hoisted(() => ({
  mockCreateChatSession: vi.fn(),
  mockStoreMessage: vi.fn(),
  mockTouchChatSession: vi.fn(),
  mockRedisGet: vi.fn(),
  mockRedisSet: vi.fn(),
  mockRedisDel: vi.fn(),
  mockExecuteDirectPaipan: vi.fn(),
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
    set: mockRedisSet,
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
  executeDirectPaipan: mockExecuteDirectPaipan,
  listDirectPaipanCatalog: vi.fn(),
}));

import {
  commitDirectPaipanForOwnedUser,
  previewDirectPaipanForOwnedUser,
} from './paipan-service.js';

describe('previewDirectPaipanForOwnedUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisSet.mockResolvedValue('OK');
    mockExecuteDirectPaipan.mockResolvedValue({
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
    });
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

  it('keeps the board title when committing a preview', async () => {
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
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.session.title).toBe('六爻排盘');
    expect(result.data.requestMessage.content).toBe('六爻排盘');
    expect(result.data.resultMessage.content).toBe('已生成：六爻排盘');
    expect(JSON.parse(result.data.resultMessage.tool_context || '[]')).toEqual([
      expect.objectContaining({
        artifactTitle: '六爻排盘',
      }),
    ]);
  });

  it('commits an anonymous preview into the authenticated user runtime', async () => {
    mockRedisGet.mockResolvedValue(
      JSON.stringify({
        previewId: 'preview-1',
        userId: null,
        runtimeId: 'web:public-preview',
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
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.session.account_id).toBe('web:user-1');
    expect(result.data.requestMessage.account_id).toBe('web:user-1');
    expect(result.data.resultMessage.account_id).toBe('web:user-1');
  });
});
