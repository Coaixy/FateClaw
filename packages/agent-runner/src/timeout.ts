/**
 * 超时与并发控制工具函数。
 */

function normalizeAbortReason(
  signal: AbortSignal,
  fallbackMessage: string,
): Error {
  const reason = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  if (typeof reason === 'string' && reason) {
    return new Error(reason);
  }
  return new Error(fallbackMessage);
}

export function throwIfAborted(
  signal: AbortSignal | undefined,
  fallbackMessage = '操作已取消',
): void {
  if (signal?.aborted) {
    throw normalizeAbortReason(signal, fallbackMessage);
  }
}

export function combineAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const activeSignals = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  if (activeSignals.length === 0) {
    return undefined;
  }
  if (activeSignals.length === 1) {
    return activeSignals[0];
  }
  // AbortSignal.any (Node 20.3+) 由 runtime 管理 listener 生命周期，
  // 任一 source signal 触发后自动清理订阅，避免长期累积 listener 泄漏。
  return AbortSignal.any(activeSignals);
}

// ---------------------------------------------------------------------------
// 超时错误类型 — 让上层能区分"真超时" vs "端点/网络/API 错误"
// ---------------------------------------------------------------------------

/** 操作在指定时间内未完成时抛出的错误。区别于网络错误、API 错误等。 */
export class TimeoutError extends Error {
  readonly label: string;
  readonly timeoutMs: number;

  constructor(label: string, ms: number) {
    super(`${label} 超时 (${ms}ms)`);
    this.name = 'TimeoutError';
    this.label = label;
    this.timeoutMs = ms;
  }
}

/** 判断一个错误是否为 TimeoutError（真超时），而非端点/网络/API 错误。 */
export function isTimeoutError(err: unknown): err is TimeoutError {
  return err instanceof Error && err.name === 'TimeoutError';
}

/**
 * 为异步操作添加超时保护。超时时会触发 AbortSignal，调用方应配合停止后续副作用。
 *
 * 注意：如果 operation 在超时前**已完成**（无论成功/失败），返回 operation 的结果。
 * 只有 operation 未在 ms 内完成时，才会抛出 TimeoutError。
 * 因此：看到 TimeoutError = 真超时，看到其他错误 = 操作本身失败（端点/网络/API 等）。
 */
export function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const timeoutError = new TimeoutError(label, ms);

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, ms);
  });

  return Promise.race([operation(controller.signal), timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * 带并发数限制的 Promise.all 替代。保留输入顺序。
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      results[idx] = await fn(items[idx], idx);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}
