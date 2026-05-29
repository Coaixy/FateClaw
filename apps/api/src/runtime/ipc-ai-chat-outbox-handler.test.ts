import { describe, expect, it, vi } from 'vitest';

const {
  mockDel,
  mockPublish,
  mockResolve,
  mockReject,
  mockStoreConversationLog,
} = vi.hoisted(() => ({
  mockDel: vi.fn(async () => 1),
  mockPublish: vi.fn(async () => 1),
  mockResolve: vi.fn(),
  mockReject: vi.fn(),
  mockStoreConversationLog: vi.fn(async () => undefined),
}));

vi.mock('../infrastructure/db.js', () => ({
  getUserById: vi.fn(),
  storeConversationLog: mockStoreConversationLog,
  storeMessage: vi.fn(),
}));

vi.mock('../infrastructure/daily-usage.js', () => ({
  incrementDailyTokens: vi.fn(),
}));

vi.mock('../infrastructure/redis.js', () => ({
  getRedis: vi.fn(() => ({
    del: mockDel,
    publish: mockPublish,
  })),
}));

vi.mock('../infrastructure/logger.js', () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../modules/billing/plans.js', () => ({
  releaseBillingReservation: vi.fn(),
  settleBillingReservation: vi.fn(async () => 0),
}));

vi.mock('../shared/conversation-log-metrics.js', () => ({
  recordConversationLogFailure: vi.fn(),
  recordConversationLogSuccess: vi.fn(),
}));

import type { PendingInboxRequest } from './ipc-payloads.js';
import { processAiChatOutboxPayload } from './ipc-ai-chat-outbox-handler.js';

describe('processAiChatOutboxPayload', () => {
  it('resolves AI Chat responses with every assistant transcript message', async () => {
    const timeout = setTimeout(() => undefined, 10_000);
    const pendingRequests = new Map<string, PendingInboxRequest>([
      [
        'req-1',
        {
          accountId: 'web:user-1',
          ownerUserId: 'user-1',
          autoDeliver: false,
          sessionId: 'session-1',
          resolve: mockResolve,
          reject: mockReject,
          timeout,
        },
      ],
    ]);

    await processAiChatOutboxPayload(
      {
        type: 'response',
        accountId: 'web:user-1',
        requestId: 'req-1',
        text: 'second reply',
        status: 'success',
        usage: { promptTokens: 3, completionTokens: 5, totalTokens: 8 },
        transcript: [
          { type: 'assistant', text: 'first reply' },
          { type: 'assistant', text: 'second reply' },
        ],
      },
      'web:user-1',
      pendingRequests,
    );

    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-1',
        status: 'success',
        text: 'second reply\n\n📥 3 · 📤 5 Finished',
        assistantMessages: [
          'first reply',
          'second reply\n\n📥 3 · 📤 5 Finished',
        ],
      }),
    );
    expect(pendingRequests.has('req-1')).toBe(false);
    expect(mockDel).toHaveBeenCalledWith('session:processing:session-1');
  });
});
