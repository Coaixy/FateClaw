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

import { __drainCancelRequestsForTests } from '../src/daemon.js';

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
      new Set(),
      redis,
    );

    expect(redis.rpop).toHaveBeenCalledWith('ipc:web:user-1:cancel');
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('keeps early cancel requests pending until the session is ready', async () => {
    const pendingCancelRequests = new Set<string>();
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
});
