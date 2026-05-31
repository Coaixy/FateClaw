import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGet,
  mockDel,
  mockLpush,
  mockLoggerInfo,
  mockSettleBillingReservation,
} = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockDel: vi.fn(async () => 1),
  mockLpush: vi.fn(async () => 1),
  mockLoggerInfo: vi.fn(),
  mockSettleBillingReservation: vi.fn(async () => 0),
}));

vi.mock('../infrastructure/db.js', () => ({
  getUserByAccountId: vi.fn(),
  getUserById: vi.fn(),
}));

vi.mock('../infrastructure/redis.js', () => ({
  getRedis: vi.fn(() => ({
    get: mockGet,
    del: mockDel,
    lpush: mockLpush,
  })),
}));

vi.mock('../infrastructure/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: mockLoggerInfo,
    warn: vi.fn(),
  },
}));

vi.mock('./ipc-outbox-handler.js', () => ({
  processOutboxPayload: vi.fn(),
}));

vi.mock('./ipc-ai-chat-outbox-handler.js', () => ({
  processAiChatOutboxPayload: vi.fn(),
}));

vi.mock('./ipc-task-handler.js', () => ({
  processTaskPayload: vi.fn(),
}));

vi.mock('../modules/billing/plans.js', () => ({
  reserveBillingForRequest: vi.fn(),
  settleBillingReservation: mockSettleBillingReservation,
}));

vi.mock('../modules/account/account-service.js', () => ({
  FREE_WECHAT_UNSUPPORTED_MESSAGE: 'free unsupported',
}));

vi.mock('../modules/chat/web-chat-runtime.js', () => ({
  getUserIdFromWebChatRuntimeId: vi.fn(),
}));

vi.mock('../modules/system/system-config.js', () => ({
  resolveUserLlmRuntime: vi.fn(),
}));

import { cancelAiChatSessionRequest } from './ipc-worker.js';
import type { PendingInboxRequest } from './ipc-payloads.js';

function createPending(
  overrides: Partial<PendingInboxRequest> = {},
): PendingInboxRequest {
  return {
    accountId: 'web:user-1',
    ownerUserId: 'user-1',
    autoDeliver: false,
    sessionId: 'session-1',
    resolve: vi.fn(),
    reject: vi.fn(),
    timeout: setTimeout(() => undefined, 10_000),
    ...overrides,
  };
}

describe('cancelAiChatSessionRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('releases the busy marker and enqueues a cancel request for the active AI chat', async () => {
    const pending = createPending();
    const pendingRequests = (
      await import('./ipc-worker.js')
    ).__getPendingAiChatRequestsForTests();
    pendingRequests.set('req-1', pending);
    mockGet.mockResolvedValueOnce('req-1');

    const result = await cancelAiChatSessionRequest('session-1');

    expect(result).toBe(true);
    expect(mockDel).toHaveBeenCalledWith('session:processing:session-1');
    expect(mockLpush).toHaveBeenCalledWith(
      'ipc:web:user-1:cancel',
      expect.stringContaining('"type":"cancel"'),
    );
    expect(mockLpush).toHaveBeenCalledWith(
      'ipc:web:user-1:cancel',
      expect.stringContaining('"requestId":"req-1"'),
    );
    expect(mockSettleBillingReservation).toHaveBeenCalledWith({
      requestId: 'req-1',
      runtime: undefined,
      promptTokens: 0,
      completionTokens: 0,
    });
    expect(pending.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-1',
        status: 'error',
        publicReasonCode: 'user_stop',
      }),
    );
    expect(pendingRequests.has('req-1')).toBe(false);
  });

  it('returns false when no request is currently processing', async () => {
    mockGet.mockResolvedValueOnce(null);

    const result = await cancelAiChatSessionRequest('session-1');

    expect(result).toBe(false);
    expect(mockDel).not.toHaveBeenCalled();
    expect(mockLpush).not.toHaveBeenCalled();
  });

  it('can cancel by processing marker and account id after pending memory is gone', async () => {
    mockGet.mockResolvedValueOnce('req-restore');

    const result = await cancelAiChatSessionRequest(
      'session-1',
      'web:user-1',
    );

    expect(result).toBe(true);
    expect(mockDel).toHaveBeenCalledWith('session:processing:session-1');
    expect(mockLpush).toHaveBeenCalledWith(
      'ipc:web:user-1:cancel',
      expect.stringContaining('"requestId":"req-restore"'),
    );
    expect(mockSettleBillingReservation).not.toHaveBeenCalled();
  });
});
