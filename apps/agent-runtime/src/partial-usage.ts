import type { TokenUsage } from './types.js';

/**
 * 请求中途报错时"截至出错已真实消耗的 Token 用量"载体。
 *
 * 背景:runPiSession 内的 usage 累加器是闭包局部对象,由事件采集器跨多轮 agent 循环
 * 就地累加真实 Token。一旦 session.prompt 抛错,该对象对上层错误处理器不可达,error 响应
 * 便不带 usage,宿主结算时按 0 关账 —— 出错前已消耗的 token 全部免费(漏收)。
 *
 * 这里用 symbol 把 partial usage 挂到抛出的 Error 上:既不与业务字段冲突,也不污染
 * Error 的可枚举属性(JSON.stringify / 日志不会意外带出),边界层 catch 再取回用于结算。
 */
const PARTIAL_USAGE = Symbol('fateclaw.partialUsage');

/**
 * 把请求中途已累计的真实 Token 用量挂到 error 上,供边界层结算。
 *
 * @param error 即将上抛的异常(非对象时静默忽略)。
 * @param usage 截至出错时的累计用量;内部做浅拷贝快照,避免后续被继续改动。
 */
export function attachPartialUsage(error: unknown, usage: TokenUsage): void {
  if (error && typeof error === 'object') {
    (error as Record<symbol, unknown>)[PARTIAL_USAGE] = { ...usage };
  }
}

/**
 * 从 error 上读回中途累计的真实 Token 用量。
 *
 * @param error 捕获到的异常。
 * @returns 挂载的 partial usage;未挂载或类型不符时返回 undefined。
 */
export function readPartialUsage(error: unknown): TokenUsage | undefined {
  if (error && typeof error === 'object') {
    const usage = (error as Record<symbol, unknown>)[PARTIAL_USAGE];
    if (usage && typeof usage === 'object') {
      return usage as TokenUsage;
    }
  }
  return undefined;
}
