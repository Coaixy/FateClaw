/**
 * 运维告警投递模块。
 *
 * 背景：inbox 堆积、子进程异常退出、计费按 0 关账等异常此前只落 pino 日志，
 * 实测出过「堆积近 8 小时才被用户投诉发现」的事故（见
 * docs/archive/ai-chat-agent-runtime-stall-fix-plan-2026-07-01.md）。本模块提供
 * 一条主动通知通道：配置 ALERT_WEBHOOK_URL 后，关键异常会 POST JSON 到该地址
 * （企业微信/飞书/钉钉机器人或任意自建接收端均可）；未配置时降级为仅记 error 日志，
 * 不引入任何新外部依赖或中间件。
 *
 * 投递语义：尽力而为（fire-and-forget）。告警失败绝不能影响主流程，
 * 因此所有调用方都应 `void sendOpsAlert(...)`，本模块内部吞掉一切投递错误。
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
