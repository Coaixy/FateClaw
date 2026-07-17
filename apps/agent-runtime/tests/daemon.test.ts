import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLog } = vi.hoisted(() => ({
  mockLog: vi.fn(),
}));

vi.mock('../src/io.js', () => ({
  log: mockLog,
}));

vi.mock('../src/agent-db.js', () => ({
  closeAgentDb: vi.fn(),
}));

vi.mock('../src/context.js', () => ({
  getContext: vi.fn(),
  initContext: vi.fn(() => ({ accountId: 'web:user-1' })),
}));

vi.mock('../src/redis.js', () => ({
  connectRedis: vi.fn(),
  disconnectRedis: vi.fn(),
  getRedis: vi.fn(),
}));

vi.mock('../src/request-boundary.js', () => ({
  executeContainerInput: vi.fn(),
}));

import { markRequestActivity } from '../src/request-scope.js';
import { executeContainerInput } from '../src/request-boundary.js';
import { getRedis } from '../src/redis.js';
import {
  __buildFatalOutboxResponseForTests,
  __cleanupPendingCancelRequestsForTests,
  __drainCancelRequestsForTests,
  __processInboxMessageForTests,
} from '../src/daemon.js';

const VALID_LLM_RUNTIME = {
  piApi: 'anthropic-messages',
  source: 'official',
  billingMode: 'none',
  modelConfigId: 'cfg-1',
  model: 'test-model',
  apiKey: 'test-key',
  providerKey: 'test-provider',
  authMode: 'anthropic_api_key',
};

describe('daemon cancel queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('aborts the active session matching the cancel request', async () => {
    const abort = vi.fn(async () => undefined);
    const activeSessions = new Map([['req-1', { abort }]]);
    const redis = {
      rpop: vi
        .fn()
        .mockResolvedValueOnce(
          JSON.stringify({
            type: 'cancel',
            accountId: 'web:user-1',
            requestId: 'req-1',
            sessionId: 'session-1',
            reason: 'user_stop',
          }),
        )
        .mockResolvedValueOnce(null),
    };

    await __drainCancelRequestsForTests(
      'web:user-1',
      activeSessions,
      new Map(),
      redis,
    );

    expect(redis.rpop).toHaveBeenCalledWith('ipc:web:user-1:cancel');
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('keeps early cancel requests pending until the session is ready', async () => {
    const pendingCancelRequests = new Map<string, number>();
    const redis = {
      rpop: vi
        .fn()
        .mockResolvedValueOnce(
          JSON.stringify({
            type: 'cancel',
            accountId: 'web:user-1',
            requestId: 'req-early',
            sessionId: 'session-1',
          }),
        )
        .mockResolvedValueOnce(null),
    };

    await __drainCancelRequestsForTests(
      'web:user-1',
      new Map(),
      pendingCancelRequests,
      redis,
    );

    expect(pendingCancelRequests.has('req-early')).toBe(true);
  });

  it('removes pending cancel requests after their TTL', () => {
    const now = 1_000 + 36 * 60 * 1000;
    const pendingCancelRequests = new Map<string, number>([
      ['req-old', 1_000],
      ['req-new', now - 10 * 60 * 1000],
    ]);

    __cleanupPendingCancelRequestsForTests(pendingCancelRequests, now);

    expect(pendingCancelRequests.has('req-old')).toBe(false);
    expect(pendingCancelRequests.has('req-new')).toBe(true);
  });
});

describe('daemon request timeout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pushes a timeout error response when executeContainerInput never settles', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(executeContainerInput).mockImplementation(
        () => new Promise(() => {}),
      );
      const lpush = vi.fn().mockResolvedValue(1);
      vi.mocked(getRedis).mockReturnValue({ lpush } as never);

      const raw = JSON.stringify({
        type: 'chat',
        requestId: 'req-timeout',
        accountId: 'web:user-1',
        userMessage: 'hi',
        llmRuntime: VALID_LLM_RUNTIME,
      });

      const runPromise = __processInboxMessageForTests(
        'web:user-1',
        raw,
        new Map(),
        new Map(),
        new Map(),
      );

      await vi.advanceTimersByTimeAsync(8 * 60 * 1000 + 1_000);
      await runPromise;

      expect(lpush).toHaveBeenCalledTimes(1);
      const [, payload] = lpush.mock.calls[0];
      const parsed = JSON.parse(payload as string);
      expect(parsed.status).toBe('error');
      expect(parsed.error).toMatch(/无进展/);
      expect(parsed.publicErrorText).toBe('这次处理超时了，请稍后再试。');
      expect(parsed.publicReasonCode).toBe('agent_timeout');
      expect(parsed.model).toBe('test-model');
      expect(parsed.provider).toBe('anthropic-messages');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not time out while Pi events keep making progress', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(executeContainerInput).mockImplementation(
        async (_input, requestScope) => {
          const heartbeat = setInterval(
            () => markRequestActivity(requestScope),
            60_000,
          );
          try {
            await new Promise((resolve) => setTimeout(resolve, 9 * 60 * 1000));
          } finally {
            clearInterval(heartbeat);
          }
          return {
            status: 'success',
            result: 'done',
            model: 'test-model',
            provider: 'anthropic-messages',
          };
        },
      );
      const lpush = vi.fn().mockResolvedValue(1);
      vi.mocked(getRedis).mockReturnValue({ lpush } as never);

      const raw = JSON.stringify({
        type: 'chat',
        requestId: 'req-active-long-run',
        accountId: 'web:user-1',
        userMessage: 'hi',
        llmRuntime: VALID_LLM_RUNTIME,
      });

      const runPromise = __processInboxMessageForTests(
        'web:user-1',
        raw,
        new Map(),
        new Map(),
        new Map(),
      );

      await vi.advanceTimersByTimeAsync(9 * 60 * 1000 + 1_000);
      await runPromise;

      expect(lpush).toHaveBeenCalledTimes(1);
      const [, payload] = lpush.mock.calls[0];
      const parsed = JSON.parse(payload as string);
      expect(parsed.status).toBe('success');
      expect(parsed.text).toBe('done');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('daemon fatal error response', () => {
  it('carries the exception stack in the internal error field and a friendly public message', () => {
    const error = new Error('boom: something exploded');
    const request = {
      type: 'chat',
      requestId: 'req-fatal',
      accountId: 'web:user-1',
      sessionId: 'session-1',
      userMessageId: 'user-msg-1',
      ownerUserId: 'owner-1',
      userMessage: 'hi',
      outboxQueue: 'ipc:web:user-1:outbox',
      llmRuntime: VALID_LLM_RUNTIME,
    } as never;

    const response = __buildFatalOutboxResponseForTests(
      'uncaughtException',
      error.stack || error.message,
      'req-fatal',
      request,
    );

    expect(response.status).toBe('error');
    expect(response.requestId).toBe('req-fatal');
    expect(response.accountId).toBe('web:user-1');
    expect(response.sessionId).toBe('session-1');
    expect(response.userMessageId).toBe('user-msg-1');
    expect(response.ownerUserId).toBe('owner-1');
    expect(response.error).toContain('uncaughtException');
    expect(response.error).toContain('boom: something exploded');
    expect(response.publicErrorText).not.toContain('boom');
    expect(response.publicReasonCode).toBe('daemon_fatal_error');
  });

  it('handles unhandledRejection kind and requests without optional session fields', () => {
    const request = {
      type: 'chat',
      requestId: 'req-fatal-2',
      accountId: 'web:user-2',
      userMessage: 'hi',
      llmRuntime: VALID_LLM_RUNTIME,
    } as never;

    const response = __buildFatalOutboxResponseForTests(
      'unhandledRejection',
      'some rejection reason',
      'req-fatal-2',
      request,
    );

    expect(response.error).toContain('unhandledRejection');
    expect(response.error).toContain('some rejection reason');
    expect(response.sessionId).toBeUndefined();
    expect(response.userMessageId).toBeUndefined();
  });
});
