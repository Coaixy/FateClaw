import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/infrastructure/db.js', () => ({
  updateAccount: vi.fn(),
}));

vi.mock('../../src/infrastructure/ilink.js', () => ({
  getUpdates: vi.fn(),
}));

vi.mock('../../src/modules/chat/message-handler.js', () => ({
  processWeixinMessage: vi.fn(),
}));

vi.mock('../../src/infrastructure/logger.js', () => ({
  logger: {
    child: vi.fn(() => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    })),
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import {
  __createAccountMessageLimiterForTests,
  __getWeixinMessageLimiterConfigForTests,
} from '../../src/runtime/poller.js';

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('iLink account message limiter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('limits concurrent message processing per account', async () => {
    const log = {
      error: vi.fn(),
      warn: vi.fn(),
    } as never;
    const limiter = __createAccountMessageLimiterForTests('account-1', log);
    const blockers = Array.from({ length: 5 }, () => createDeferred());
    let started = 0;

    for (const blocker of blockers) {
      expect(
        limiter.enqueue(async () => {
          started += 1;
          await blocker.promise;
        }),
      ).toBe(true);
    }

    expect(started).toBe(3);
    blockers[0]?.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(started).toBe(4);
    limiter.stop();
  });

  it('rejects new messages when backlog is full', () => {
    const log = {
      error: vi.fn(),
      warn: vi.fn(),
    } as never;
    const limiter = __createAccountMessageLimiterForTests('account-1', log);
    const { maxConcurrency, maxBacklog } =
      __getWeixinMessageLimiterConfigForTests();
    const never = () => new Promise<void>(() => undefined);

    for (let index = 0; index < maxConcurrency + maxBacklog; index += 1) {
      expect(limiter.enqueue(never, `msg-${index}`)).toBe(true);
    }

    expect(limiter.enqueue(never, 'msg-overflow')).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        msgId: 'msg-overflow',
        limit: maxBacklog,
      }),
      'iLink 消息处理积压已满，丢弃新消息',
    );
    limiter.stop();
  });
});
