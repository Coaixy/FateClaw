/**
 * Pi session 健康维护后台任务。
 *
 * 该任务只自动触发现有 DB 驱动的 cleanup：先处理已归档会话，再处理
 * 长期未活跃会话。孤儿文件的物理清理风险更高，保留为管理员手动入口。
 */

import { acquireRedisWorkerLock } from '#infrastructure/redis';
import { logger } from '#infrastructure/logger';
import { cleanupPiSessionFilesForAdmin } from '#modules/admin/admin-service';
import { getPiSessionHealthPolicy } from '#modules/system/system-config';

/** Pi session 健康任务固定运行间隔：每 24 小时检查一次后台配置。 */
const PI_SESSION_HEALTH_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 进程启动后延迟首次检查，避免启动期 DB/IO 压力叠加。 */
const PI_SESSION_HEALTH_INITIAL_DELAY_MS = 60 * 1000;
/** 每种 cleanup mode 单轮最多处理的 session 数。 */
const PI_SESSION_HEALTH_BATCH_LIMIT = 500;
/** 多实例分布式锁 TTL，避免单轮异常卡住后永久失效。 */
const PI_SESSION_HEALTH_LOCK_TTL_MS = 6 * 60 * 60 * 1000;
const PI_SESSION_HEALTH_LOCK_KEY = 'pi-session-health:worker-lock';

let intervalTimer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
let running = false;

/**
 * 执行一轮 Pi session 健康维护。
 *
 * @returns Promise<void>；错误会记录日志，不向定时器调用方抛出。
 * @remarks 该函数导出用于测试和必要时手动触发；孤儿文件不会在这里物理删除。
 */
export async function runPiSessionHealthOnce(): Promise<void> {
  if (running) {
    logger.debug('Pi session 健康维护仍在运行，跳过本轮');
    return;
  }

  running = true;
  try {
    const policy = await getPiSessionHealthPolicy();
    if (!policy.enabled) {
      logger.debug(
        { inactiveCleanupDays: policy.inactiveCleanupDays },
        'Pi session 健康维护未启用，跳过本轮',
      );
      return;
    }

    const lock = await acquireRedisWorkerLock(
      PI_SESSION_HEALTH_LOCK_KEY,
      PI_SESSION_HEALTH_LOCK_TTL_MS,
    );
    if (!lock) {
      logger.debug('Pi session 健康维护锁已被其他实例持有，跳过本轮');
      return;
    }

    try {
      const softDeleted = await cleanupPiSessionFilesForAdmin({
        mode: 'soft_deleted',
        limit: PI_SESSION_HEALTH_BATCH_LIMIT,
      });
      const inactive = await cleanupPiSessionFilesForAdmin({
        mode: 'inactive',
        inactiveDays: policy.inactiveCleanupDays,
        limit: PI_SESSION_HEALTH_BATCH_LIMIT,
      });
      logger.info(
        {
          inactiveCleanupDays: policy.inactiveCleanupDays,
          batchLimit: PI_SESSION_HEALTH_BATCH_LIMIT,
          softDeleted,
          inactive,
        },
        'Pi session 健康维护完成',
      );
    } finally {
      await lock.release();
    }
  } catch (err) {
    logger.warn({ err }, 'Pi session 健康维护出错');
  } finally {
    running = false;
  }
}

/**
 * 启动 Pi session 健康维护后台任务。
 *
 * @remarks 任务会固定每天检查一次后台配置；未启用时不会执行 cleanup。
 */
export function startPiSessionHealthWorker(): void {
  if (intervalTimer || initialTimer) {
    logger.warn('Pi session 健康维护任务已在运行，跳过重复启动');
    return;
  }

  logger.info(
    {
      intervalMs: PI_SESSION_HEALTH_INTERVAL_MS,
      initialDelayMs: PI_SESSION_HEALTH_INITIAL_DELAY_MS,
      batchLimit: PI_SESSION_HEALTH_BATCH_LIMIT,
    },
    '启动 Pi session 健康维护后台任务',
  );

  initialTimer = setTimeout(() => {
    initialTimer = null;
    runPiSessionHealthOnce().catch(() => {
      /* 错误已在 runPiSessionHealthOnce 内部 logger.warn */
    });
  }, PI_SESSION_HEALTH_INITIAL_DELAY_MS);
  initialTimer.unref?.();

  intervalTimer = setInterval(() => {
    runPiSessionHealthOnce().catch(() => {
      /* 同上 */
    });
  }, PI_SESSION_HEALTH_INTERVAL_MS);
  intervalTimer.unref?.();
}

/** 停止 Pi session 健康维护任务，用于测试或优雅关闭。 */
export function stopPiSessionHealthWorker(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
}
