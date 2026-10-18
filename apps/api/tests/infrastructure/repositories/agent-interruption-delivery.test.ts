import { beforeEach, describe, expect, it, vi } from 'vitest';
const { query, release } = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
}));
vi.mock('#infrastructure/db-pool', () => ({
  getDbPool: () => ({ connect: async () => ({ query, release }) }),
}));
vi.mock('#infrastructure/repositories/chat-repository', () => ({
  storeMessage: vi.fn(),
}));
import { withAgentInterruptionDelivery } from '#infrastructure/repositories/agent-requests-repository';

describe('interruption delivery ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query.mockResolvedValue({ rows: [] });
  });
  it.each(['completed', 'result_ready'])(
    'does not deliver an interruption after %s',
    async (state) => {
      query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ account_id: 'account', state }] });
      const deliver = vi.fn();
      await expect(
        withAgentInterruptionDelivery('request', 'account', deliver),
      ).resolves.toBeNull();
      expect(deliver).not.toHaveBeenCalled();
      expect(query.mock.calls[1][0]).toContain('FOR UPDATE');
      expect(query).toHaveBeenLastCalledWith('COMMIT');
      expect(release).toHaveBeenCalledOnce();
    },
  );
  it('rolls back failed interruption delivery without consuming a final receipt', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [{ account_id: 'account', state: 'interrupted' }],
    });
    await expect(
      withAgentInterruptionDelivery('request', 'account', async () => {
        throw new Error('database write failed');
      }),
    ).rejects.toThrow('database write failed');
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(
      query.mock.calls.some(([sql]) => sql.includes('agent_result_deliveries')),
    ).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });
});
