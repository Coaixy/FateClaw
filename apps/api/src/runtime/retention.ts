/**
 * 数据保留策略：定时清理过期数据。
 *
 * 两类清理：
 *  - conversation_log_payloads.trace_events 列：纯调试数据，保留 N 天足够排障，过期即置 NULL。
 *  - 过期已久的对外会话 open_sessions 及其兜底 chat_sessions、messages：会话有 30 天滑动
 *    TTL，过期后再宽限 OPEN_SESSION_RETENTION_DAYS 天供对账，超过即整套物理删除。
 *
 * transcript / usage / agent_graph_summary 等其它业务数据不在此处清理。
 */

import {
  OPEN_SESSION_RETENTION_DAYS,
  TRACE_RETENTION_DAYS,
} from '#infrastructure/config';
import {
  purgeExpiredOpenSessions,
  purgeExpiredTraceEvents,
} from '#infrastructure/db';
import { logger } from '#infrastructure/logger';

/** 清理任务运行间隔：每 24 小时一次。 */
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

let retentionTimer: NodeJS.Timeout | null = null;

async function runRetentionOnce(): Promise<void> {
  try {
    const purgedRows = await purgeExpiredTraceEvents(TRACE_RETENTION_DAYS);
    if (purgedRows > 0) {
      logger.info(
        { purgedRows, retentionDays: TRACE_RETENTION_DAYS },
        '已清理过期 trace_events',
      );
    } else {
      logger.debug(
        { retentionDays: TRACE_RETENTION_DAYS },
        'trace_events 清理任务无需处理的行',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'trace_events 清理任务出错');
  }

  // 清理过期已久的对外会话（open_sessions）及其兜底 chat_sessions、messages。独立 try/catch，
  // 与 trace 清理互不连累：一者失败不影响另一者。
  try {
    const purgedSessions = await purgeExpiredOpenSessions(
      OPEN_SESSION_RETENTION_DAYS,
    );
    if (purgedSessions > 0) {
      logger.info(
        { purgedSessions, retentionDays: OPEN_SESSION_RETENTION_DAYS },
        '已清理过期对外会话及其衍生数据',
      );
    } else {
      logger.debug(
        { retentionDays: OPEN_SESSION_RETENTION_DAYS },
        '对外会话清理任务无需处理的行',
      );
    }
  } catch (err) {
    logger.warn({ err }, '对外会话清理任务出错');
  }
}

/**
 * 启动保留策略后台任务。
 * - 启动时立即跑一次（覆盖"进程长时间停机后重启"的场景）
 * - 之后每 24 小时跑一次
 *
 * UPDATE 语句是幂等的（条件 trace_events IS NOT NULL），多跑无副作用。
 */
export function startRetentionWorker(): void {
  if (retentionTimer) {
    logger.warn('保留策略任务已在运行，跳过重复启动');
    return;
  }
  logger.info(
    { retentionDays: TRACE_RETENTION_DAYS, intervalMs: RETENTION_INTERVAL_MS },
    '启动保留策略后台任务',
  );
  // 启动时立即跑一次，不阻塞启动流程
  runRetentionOnce().catch(() => {
    /* 错误已在 runRetentionOnce 内部 logger.warn */
  });
  retentionTimer = setInterval(() => {
    runRetentionOnce().catch(() => {
      /* 同上 */
    });
  }, RETENTION_INTERVAL_MS);
  retentionTimer.unref();
}

/** 停止保留策略任务，用于测试或优雅关闭。 */
export function stopRetentionWorker(): void {
  if (retentionTimer) {
    clearInterval(retentionTimer);
    retentionTimer = null;
  }
}
