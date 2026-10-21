import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCleanupPiSessionFilesForAdmin,
  mockGetPiSessionHealthPolicy,
  mockAcquireRedisWorkerLock,
  mockLockRelease,
} = vi.hoisted(() => ({
  mockCleanupPiSessionFilesForAdmin: vi.fn(),
  mockGetPiSessionHealthPolicy: vi.fn(),
  mockAcquireRedisWorkerLock: vi.fn(),
  mockLockRelease: vi.fn(async () => undefined),
}));

vi.mock('#modules/admin/admin-service', () => ({
  cleanupPiSessionFilesForAdmin: mockCleanupPiSessionFilesForAdmin,
}));

vi.mock('#modules/system/system-config', () => ({
  getPiSessionHealthPolicy: mockGetPiSessionHealthPolicy,
}));

vi.mock('#infrastructure/redis', () => ({
  // 锁逻辑已移入共享 helper acquireRedisWorkerLock；pi-worker 不再直接触碰 Redis，
  // 仅 mock 该 helper 以控制「拿到锁 / 被其他实例占用」两种路径。
  acquireRedisWorkerLock: mockAcquireRedisWorkerLock,
}));

vi.mock('#infrastructure/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import {
  runPiSessionHealthOnce,
  stopPiSessionHealthWorker,
} from '#runtime/pi-session-health-worker';

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
    stopPiSessionHealthWorker();
    vi.clearAllMocks();
    mockLockRelease.mockResolvedValue(undefined);
    mockAcquireRedisWorkerLock.mockResolvedValue({ release: mockLockRelease });
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

    expect(mockAcquireRedisWorkerLock).not.toHaveBeenCalled();
    expect(mockCleanupPiSessionFilesForAdmin).not.toHaveBeenCalled();
  });

  it('runs soft-deleted cleanup before inactive cleanup when enabled', async () => {
    mockGetPiSessionHealthPolicy.mockResolvedValue({
      enabled: true,
      inactiveCleanupDays: 45,
      orphanGraceDays: 30,
    });

    await runPiSessionHealthOnce();

    expect(mockAcquireRedisWorkerLock).toHaveBeenCalledWith(
      'pi-session-health:worker-lock',
      21_600_000,
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
    expect(mockLockRelease).toHaveBeenCalled();
  });

  it('skips cleanup when another instance holds the lock', async () => {
    mockGetPiSessionHealthPolicy.mockResolvedValue({
      enabled: true,
      inactiveCleanupDays: 30,
      orphanGraceDays: 30,
    });
    mockAcquireRedisWorkerLock.mockResolvedValue(null);

    await runPiSessionHealthOnce();

    expect(mockCleanupPiSessionFilesForAdmin).not.toHaveBeenCalled();
    expect(mockLockRelease).not.toHaveBeenCalled();
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
