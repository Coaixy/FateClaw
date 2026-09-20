import { beforeEach, describe, expect, it, vi } from 'vitest';
const { redis } = vi.hoisted(() => ({
  redis: { lindex: vi.fn(), rpoplpush: vi.fn(), lrem: vi.fn(), eval: vi.fn() },
}));
vi.mock('../../src/infrastructure/redis.js', () => ({ getRedis: () => redis }));
import {
  acknowledgeAiChatResult,
  claimAiChatResult,
} from '../../src/runtime/reliable-ai-chat-outbox.js';

describe('reliable AI Chat result transport', () => {
  beforeEach(() => vi.resetAllMocks());
  it('retries the unacknowledged result before claiming fresh work', async () => {
    redis.lindex.mockResolvedValue('pending');
    expect(await claimAiChatResult('queue')).toBe('pending');
    expect(redis.rpoplpush).not.toHaveBeenCalled();
  });
  it('claims a fresh result atomically into processing', async () => {
    redis.lindex.mockResolvedValue(null);
    redis.rpoplpush.mockResolvedValue('fresh');
    expect(await claimAiChatResult('queue')).toBe('fresh');
    expect(redis.rpoplpush).toHaveBeenCalledWith('queue', 'queue:processing');
  });
  it('only acknowledges the matching transport copy', async () => {
    await acknowledgeAiChatResult('queue', 'done');
    expect(redis.lrem).toHaveBeenCalledWith('queue:processing', 1, 'done');
  });
  it('propagates acknowledgement failure so the caller can retry', async () => {
    redis.lrem.mockRejectedValue(new Error('synthetic disconnect'));
    await expect(acknowledgeAiChatResult('queue', 'done')).rejects.toThrow(
      'synthetic disconnect',
    );
  });
});
