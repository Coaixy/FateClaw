/**
 * conversation_logs 写入失败的轻量计数器。
 *
 * storeConversationLog 是 fire-and-forget 写入：失败时调用方已 resolve pending，
 * 无法重试。这里维护一个滚动失败计数器，达到阈值时升级日志级别让 SRE 关注。
 */

import { logger } from '#infrastructure/logger';

const ESCALATE_THRESHOLD = 10;

let consecutiveFailures = 0;
let totalFailures = 0;
let totalSuccesses = 0;

export function recordConversationLogSuccess(): void {
  totalSuccesses += 1;
  consecutiveFailures = 0;
}

export function recordConversationLogFailure(
  context: { accountId: string; requestId: string | undefined },
  err: unknown,
): void {
  consecutiveFailures += 1;
  totalFailures += 1;

  // 单次失败 warn；连续失败超阈值后升级 error 触发告警
  const payload = {
    ...context,
    err,
    consecutiveFailures,
    totalFailures,
    totalSuccesses,
  };
  if (consecutiveFailures >= ESCALATE_THRESHOLD) {
    logger.error(
      payload,
      `conversation_logs 连续写入失败 ${consecutiveFailures} 次，请检查数据库`,
    );
  } else {
    logger.warn(payload, '存储 conversation log 失败');
  }
}
