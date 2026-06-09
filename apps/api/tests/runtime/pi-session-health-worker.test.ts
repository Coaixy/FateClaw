import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCleanupPiSessionFilesForAdmin,
  mockGetPiSessionHealthPolicy,
  mockRedisEval,
  mockRedisSet,
} = vi.hoisted(() => ({
  mockCleanupPiSessionFilesForAdmin: vi.fn(),
  mockGetPiSessionHealthPolicy: vi.fn(),
  mockRedisEval: vi.fn(),
  mockRedisSet: vi.fn(),
}));

vi.mock('../../src/modules/admin/admin-service.js', () => ({
  cleanupPiSessionFilesForAdmin: mockCleanupPiSessionFilesForAdmin,
}));

vi.mock('../../src/modules/system/system-config.js', () => ({
  getPiSessionHealthPolicy: mockGetPiSessionHealthPolicy,
}));

vi.mock('../../src/infrastructure/redis.js', () => ({
  getRedis: vi.fn(() => ({
    eval: mockRedisEval,
    set: mockRedisSet,
  })),
}));

vi.mock('../../src/infrastructure/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import { runPiSessionHealthOnce } from '../../src/runtime/pi-session-health-worker.js';

function cleanupResult(mode: 'soft_deleted' | 'inactive') {
  return {
    success: true,
    mode,
    inactive_days: mode === 'inactive' ? 30 : null,
    cutoff_at: null,
    cursor_before: null,
    cursor_after: null,
    cursor_reset: false,
    scanned_sessions: 0,
    archived_sessions: 0,
    payload_restored_from_snapshot: 0,
    unarchivable_sessions: 0,
    already_archived_sessions: 0,
    touched_sessions: 0,
    deleted_jsonl_files: 0,
    deleted_path_files: 0,
    missing_jsonl_files: 0,
    skipped_unsafe_files: [],
  };
}

describe('runPiSessionHealthOnce', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisSet.mockResolvedValue('OK');
    mockRedisEval.mockResolvedValue(1);
    mockCleanupPiSessionFilesForAdmin.mockImplementation(
      async (input: { mode: 'soft_deleted' | 'inactive' }) =>
        cleanupResult(input.mode),
    );
  });

  it('skips cleanup when the policy is disabled', async () => {
    mockGetPiSessionHealthPolicy.mockResolvedValue({
      enabled: false,
      inactiveCleanupDays: 30,
      orphanGraceDays: 30,
    });

    await runPiSessionHealthOnce();

    expect(mockRedisSet).not.toHaveBeenCalled();
    expect(mockCleanupPiSessionFilesForAdmin).not.toHaveBeenCalled();
  });

  it('runs soft-deleted cleanup before inactive cleanup when enabled', async () => {
    mockGetPiSessionHealthPolicy.mockResolvedValue({
      enabled: true,
      inactiveCleanupDays: 45,
      orphanGraceDays: 30,
    });

    await runPiSessionHealthOnce();

    expect(mockRedisSet).toHaveBeenCalledWith(
      'pi-session-health:worker-lock',
      expect.any(String),
      'PX',
      21_600_000,
      'NX',
    );
    expect(mockCleanupPiSessionFilesForAdmin).toHaveBeenNthCalledWith(1, {
      mode: 'soft_deleted',
      limit: 500,
    });
    expect(mockCleanupPiSessionFilesForAdmin).toHaveBeenNthCalledWith(2, {
      mode: 'inactive',
      inactiveDays: 45,
      limit: 500,
    });
    expect(mockRedisEval).toHaveBeenCalled();
  });

  it('skips cleanup when another instance holds the lock', async () => {
    mockGetPiSessionHealthPolicy.mockResolvedValue({
      enabled: true,
      inactiveCleanupDays: 30,
      orphanGraceDays: 30,
    });
    mockRedisSet.mockResolvedValue(null);

    await runPiSessionHealthOnce();

    expect(mockCleanupPiSessionFilesForAdmin).not.toHaveBeenCalled();
    expect(mockRedisEval).not.toHaveBeenCalled();
  });

  it('skips overlapping runs in the same process', async () => {
    let resolvePolicy: (value: unknown) => void = () => undefined;
    mockGetPiSessionHealthPolicy.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePolicy = resolve;
      }),
    );

    const firstRun = runPiSessionHealthOnce();
    await runPiSessionHealthOnce();
    resolvePolicy({
      enabled: false,
      inactiveCleanupDays: 30,
      orphanGraceDays: 30,
    });
    await firstRun;

    expect(mockGetPiSessionHealthPolicy).toHaveBeenCalledTimes(1);
    expect(mockCleanupPiSessionFilesForAdmin).not.toHaveBeenCalled();
  });
});
