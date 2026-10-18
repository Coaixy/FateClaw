/**
 * Best-effort operations alert delivery.
 *
 * Inbox backlogs, unexpected child exits, and zero-charge billing closures need
 * a proactive signal beyond logs. ALERT_WEBHOOK_URL enables JSON delivery to an
 * operator-controlled receiver; without it, alerts remain error-level logs.
 *
 * Callers use `void sendOpsAlert(...)`: delivery failures are contained here so
 * an unavailable alert receiver cannot interrupt the operation being monitored.
 */

import { ALERT_WEBHOOK_URL } from './config.js';
import { logger } from './logger.js';

/** 同类告警（按 kind 区分）的最小投递间隔，防止巡检任务每分钟重复轰炸。 */
const ALERT_MIN_INTERVAL_MS = 5 * 60 * 1000;
/** webhook 请求超时上限。 */
const ALERT_REQUEST_TIMEOUT_MS = 5_000;

/** 每类告警最近一次成功投递的时间戳，用于节流。 */
const lastSentAtByKind = new Map<string, number>();

/** 运维告警输入。 */
export interface OpsAlertInput {
  /** 告警类别（如 `inbox_stall_cleanup`、`agent_process_exited`），同类告警按此节流。 */
  kind: string;
  /** 一句话标题，面向值班人员。 */
  title: string;
  /** 详细描述（可选）。 */
  detail?: string;
  /** 结构化上下文（accountId、requestId、队列名等），随 webhook 一并投递。 */
  context?: Record<string, unknown>;
}

/**
 * 发送一条运维告警。
 *
 * 无论 webhook 是否配置，都会先落一条带 `opsAlert` 标记的 error 日志
 * （保证日志侧可检索）；配置了 webhook 且未被节流时再异步投递。
 *
 * @param input 告警内容。
 * @returns 始终 resolve；投递失败只记 warn 日志，绝不抛错。
 */
export async function sendOpsAlert(input: OpsAlertInput): Promise<void> {
  logger.error(
    { opsAlert: input.kind, ...input.context },
    `[运维告警] ${input.title}${input.detail ? `：${input.detail}` : ''}`,
  );

  if (!ALERT_WEBHOOK_URL) return;

  const now = Date.now();
  const lastSentAt = lastSentAtByKind.get(input.kind) ?? 0;
  if (now - lastSentAt < ALERT_MIN_INTERVAL_MS) {
    return; // 同类告警节流窗口内，只留日志不重复投递
  }
  lastSentAtByKind.set(input.kind, now);

  try {
    const controller = new AbortController();
    const timeoutTimer = setTimeout(
      () => controller.abort(),
      ALERT_REQUEST_TIMEOUT_MS,
    );
    timeoutTimer.unref?.();
    await fetch(ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'fateclaw-api',
        kind: input.kind,
        title: input.title,
        detail: input.detail,
        context: input.context,
        timestamp: new Date().toISOString(),
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutTimer);
  } catch (err) {
    // 告警通道自身故障只降级记日志，不能反过来影响业务主流程。
    logger.warn({ err, kind: input.kind }, '运维告警 webhook 投递失败');
  }
}
