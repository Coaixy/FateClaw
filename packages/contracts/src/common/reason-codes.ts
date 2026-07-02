/**
 * AI 请求失败原因码（publicReasonCode）的类型契约。
 *
 * 背景：原因码此前是散落在 apps/api 与 apps/agent-runtime 十余处的裸字符串
 * 字面量，生产者/消费者/前端都无法在编译期校验取值集合，新增或改名只能靠
 * 全仓 grep。本文件是唯一的取值清单：
 * - apps/api、apps/web、apps/admin 直接引用本类型；
 * - apps/agent-runtime 因构建上刻意不依赖 contracts（独立部署产物），在
 *   `apps/agent-runtime/src/types.ts` 维护一份同名镜像类型，两侧一致性由
 *   `apps/api/tests/shared/reason-codes-contract.test.ts` 锁定。
 *
 * 新增原因码时：先加到这里，再同步 agent-runtime 镜像，最后跑测试确认。
 */

/** 全部合法的失败原因码取值。 */
export const PUBLIC_REASON_CODES = [
  /** 请求处理超时（daemon 硬超时 / API 兜底超时）。 */
  'agent_timeout',
  /** 上游模型限流（429 等）。 */
  'rate_limited',
  /** 上下文/消息过长被中断。 */
  'context_too_long',
  /** 排盘等场景缺少必要输入（出生时间等）。 */
  'missing_input',
  /** Pi/工具协议错误。 */
  'protocol_error',
  /** 意图路由失败（仅 api 侧产生）。 */
  'router_error',
  /** 用户自配模型调用失败（仅 agent 侧产生，附排查指引）。 */
  'custom_model_error',
  /** daemon 进程级未捕获异常崩溃兜底。 */
  'daemon_fatal_error',
  /** daemon 请求级处理失败兜底。 */
  'daemon_error',
  /** API 侧提交入队失败兜底。 */
  'submit_error',
  /** inbox 堆积巡检判定处理超时并自动清理。 */
  'inbox_stall_timeout',
  /** 本地 agent-runtime 子进程异常退出，在途请求被批量标记失败。 */
  'agent_process_exited',
  /** 用户主动停止本轮回复。 */
  'user_stop',
  /** 未匹配到任何特征的内部错误（默认值）。 */
  'internal_error',
] as const;

/** 失败原因码联合类型。 */
export type PublicReasonCode = (typeof PUBLIC_REASON_CODES)[number];

/**
 * 判断任意字符串是否为合法原因码（跨进程边界收窄 unknown 时使用）。
 *
 * @param value 待检查的值。
 * @returns 属于 {@link PUBLIC_REASON_CODES} 时返回 true。
 */
export function isPublicReasonCode(value: unknown): value is PublicReasonCode {
  return (
    typeof value === 'string' &&
    (PUBLIC_REASON_CODES as readonly string[]).includes(value)
  );
}
