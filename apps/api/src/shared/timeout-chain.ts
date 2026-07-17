/**
 * AI 请求超时链的单一事实源。
 *
 * 背景：同一条「用户消息 → agent 处理 → 响应落库」链路上，此前存在三个互不知晓的
 * 超时配置——daemon 无进展 watchdog（AGENT_RUNTIME_REQUEST_TIMEOUT_MS，默认 8 分钟）、
 * daemon 绝对总时长（AGENT_RUNTIME_REQUEST_MAX_DURATION_MS，默认 25 分钟）、
 * inbox 堆积清理阈值、API 侧请求超时（AGENT_REQUEST_TIMEOUT /
 * AI_CHAT_REQUEST_TIMEOUT，默认 30 分钟）以及会话锁 TTL（曾硬编码 35 分钟）。
 * 任何一处被运维单独调整都会静默破坏时序不变式，重新引入误杀/双写。
 *
 * 本模块收敛为：
 * 1. 运维只需（可选地）配置三个 env——AGENT_RUNTIME_REQUEST_TIMEOUT_MS、
 *    AGENT_RUNTIME_REQUEST_MAX_DURATION_MS 与 AGENT_REQUEST_TIMEOUT /
 *    AI_CHAT_REQUEST_TIMEOUT；
 * 2. 其余阈值（堆积清理、会话锁 TTL）自动派生，保证不变式恒成立：
 *    daemon 无进展 watchdog < daemon 绝对总时长 < inbox 堆积清理阈值；
 *    inbox 堆积清理阈值 < API 请求超时 < 会话锁 TTL；
 * 3. daemon 侧的值由宿主在 spawn 时经 env 注入（见 agent-env.ts），
 *    杜绝两个进程各读各的默认值产生分歧；
 * 4. 无法自动派生的违例（如 API 超时被配得不大于 daemon 绝对上限）在模块加载时
 *    直接抛错快速失败，而不是留到线上静默误杀。
 */

/**
 * 解析毫秒整数 env，非法值回退默认值。
 *
 * @param raw env 原始字符串。
 * @param fallback 默认毫秒值。
 * @returns 解析后的毫秒数。
 */
function parseMsEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * agent-runtime 连续无进展超时（daemon 内 watchdog 的停滞判定阈值）。
 * Pi 流式 delta、回合切换和工具事件都会刷新活动时间，因此它不再限制正常长任务
 * 的总时长。宿主 spawn 子进程时会把本值注入 env。
 */
export const AGENT_RUNTIME_REQUEST_TIMEOUT_MS = Math.max(
  60_000,
  parseMsEnv(process.env.AGENT_RUNTIME_REQUEST_TIMEOUT_MS, 8 * 60 * 1000),
);

/**
 * agent-runtime 请求绝对总时长上限。防止「持续有活动但永不收敛」的无限循环。
 * 默认 25 分钟，必须小于 API 请求超时，为 abort/outbox/落库释放资源留出余量。
 */
export const AGENT_RUNTIME_REQUEST_MAX_DURATION_MS = Math.max(
  AGENT_RUNTIME_REQUEST_TIMEOUT_MS + 60_000,
  parseMsEnv(
    process.env.AGENT_RUNTIME_REQUEST_MAX_DURATION_MS,
    25 * 60 * 1000,
  ),
);

/** 微信收件箱请求的 API 侧兜底超时（pending reject 定时器）。 */
export const AGENT_REQUEST_TIMEOUT_MS = parseMsEnv(
  process.env.AGENT_REQUEST_TIMEOUT,
  30 * 60 * 1000,
);

/** 站内 AI Chat 请求的 API 侧兜底超时（pending reject 定时器）。 */
export const AI_CHAT_REQUEST_TIMEOUT_MS = parseMsEnv(
  process.env.AI_CHAT_REQUEST_TIMEOUT,
  30 * 60 * 1000,
);

/** 两类请求超时的较大值：陈旧并发槽/等待项/反查键的统一老化窗口。 */
export const MAX_REQUEST_TIMEOUT_MS = Math.max(
  AGENT_REQUEST_TIMEOUT_MS,
  AI_CHAT_REQUEST_TIMEOUT_MS,
);

/**
 * inbox 堆积告警阈值：队尾消息年龄超过此值先告警（尚不清理）。
 */
export const INBOX_STALL_WARN_MS = 5 * 60 * 1000;

/**
 * inbox 堆积自动清理阈值：必须比 daemon 请求绝对总时长更长，避免误杀
 * 「前一条请求仍在处理、当前消息尚未轮到」的正常排队。从绝对上限自动派生
 * （+2 分钟余量，且不低于 10 分钟）。
 */
export const INBOX_STALL_FAIL_MS = Math.max(
  10 * 60 * 1000,
  AGENT_RUNTIME_REQUEST_MAX_DURATION_MS + 2 * 60 * 1000,
);

/**
 * ai-chat outbox 无主消息判定阈值：outbox 消息在有监听器时毫秒级被消费，
 * 监听器 supervisor 崩溃重启的最大退避也只有 30 秒；队尾消息超过此年龄
 * 即可断定当前进程没有该账号的消费者（典型场景：API 非优雅重启后的遗留响应），
 * 由巡检任务代为消费落库。
 */
export const AI_CHAT_OUTBOX_ORPHAN_MS = 3 * 60 * 1000;

/**
 * AI Chat 会话忙碌锁（session:processing:*）TTL 秒数：
 * 比 API 侧请求超时多 5 分钟缓冲，从请求超时自动派生。
 */
export const SESSION_PROCESSING_LOCK_TTL_SECONDS = Math.ceil(
  (MAX_REQUEST_TIMEOUT_MS + 5 * 60 * 1000) / 1000,
);

// ---------------------------------------------------------------------------
// 时序不变式校验：无法自动派生消解的违例直接快速失败。
// daemon 绝对总时长必须 < inbox 堆积清理阈值 < API 请求超时，否则：
// - 清理阈值过短会把仍排在活跃请求后面的 inbox 消息误判为无人消费；
// - API 超时过短会先 reject，daemon 稍后推回的响应变成「迟到的孤儿」。
// ---------------------------------------------------------------------------
if (INBOX_STALL_FAIL_MS >= AGENT_REQUEST_TIMEOUT_MS) {
  throw new Error(
    `超时链配置违例：INBOX_STALL_FAIL_MS（${INBOX_STALL_FAIL_MS}ms）` +
      `必须小于 AGENT_REQUEST_TIMEOUT（${AGENT_REQUEST_TIMEOUT_MS}ms）`,
  );
}
if (INBOX_STALL_FAIL_MS >= AI_CHAT_REQUEST_TIMEOUT_MS) {
  throw new Error(
    `超时链配置违例：INBOX_STALL_FAIL_MS（${INBOX_STALL_FAIL_MS}ms）` +
      `必须小于 AI_CHAT_REQUEST_TIMEOUT（${AI_CHAT_REQUEST_TIMEOUT_MS}ms）`,
  );
}
