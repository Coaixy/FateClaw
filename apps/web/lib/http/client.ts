import type { ApiErrorResponse } from '@fateclaw/contracts/common';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || '';
const DEFAULT_SERVER_ERROR_MESSAGE = '服务暂时不可用，请稍后重试';
const DEFAULT_NETWORK_ERROR_MESSAGE = '网络连接失败，请检查服务是否正常后重试';
const DEFAULT_INVALID_RESPONSE_MESSAGE = '服务返回异常，请稍后重试';

type ApiErrorBody = ApiErrorResponse;

interface RequestJsonOptions extends RequestInit {
  exposeServerErrorMessage?: boolean;
  /** 请求兜底超时（毫秒）；不传则不设上限，维持现有行为。 */
  timeoutMs?: number;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function getApiBase() {
  return API_BASE;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractErrorMessage(body: unknown): string | null {
  if (!isRecord(body) || typeof body.error !== 'string') {
    return null;
  }
  const message = body.error.trim();
  return message || null;
}

/**
 * 组合"调用方传入的取消信号"和"超时"两个来源为一个 AbortSignal。
 * 不用 AbortSignal.any——项目没有声明浏览器兼容性目标，那是 2024 年才广泛
 * 支持的较新 API；手写组合用的是 AbortController，兼容性更保守可靠。
 */
function createTimeoutSignal(
  timeoutMs: number | undefined,
  callerSignal: AbortSignal | null | undefined,
): { signal: AbortSignal | undefined; cleanup: () => void } {
  if (!timeoutMs) {
    return { signal: callerSignal ?? undefined, cleanup: () => {} };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onCallerAbort = () => controller.abort();
  // 调用方传入的信号可能在此刻已经是 aborted 状态——此时 abort 事件不会再次派发，
  // 只 addEventListener 会永远等不到、组合信号不触发、本应立即取消的请求照常发出。
  // 因此先主动检查一次，已中止就立即同步中止组合信号。
  if (callerSignal?.aborted) {
    controller.abort();
  } else {
    callerSignal?.addEventListener('abort', onCallerAbort);
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    },
  };
}

function getPublicErrorMessage(
  status: number,
  body: unknown,
  options: { exposeServerErrorMessage: boolean },
): string {
  const serverErrorMessage = extractErrorMessage(body);
  if (status >= 500 && !options.exposeServerErrorMessage) {
    return DEFAULT_SERVER_ERROR_MESSAGE;
  }
  return (
    serverErrorMessage ||
    (status === 401
      ? '登录状态已失效，请重新登录'
      : status === 404
        ? '请求的内容不存在或已被删除'
        : '请求失败，请检查后重试')
  );
}

/**
 * 浏览器侧统一请求底座。
 * 负责 token 注入、网络异常兜底、非 JSON 响应识别和错误文案归一化。
 */
export async function requestJson<T>(
  path: string,
  options: RequestJsonOptions = {},
): Promise<T> {
  const {
    exposeServerErrorMessage = false,
    timeoutMs,
    ...fetchOptions
  } = options;
  const token =
    typeof window !== 'undefined' ? localStorage.getItem('token') : null;

  const headers: Record<string, string> = {
    ...((fetchOptions.headers as Record<string, string>) || {}),
  };

  if (fetchOptions.body) {
    headers['Content-Type'] = 'application/json';
  }

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const { signal, cleanup } = createTimeoutSignal(
    timeoutMs,
    fetchOptions.signal,
  );

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...fetchOptions,
      cache: fetchOptions.cache ?? 'no-store',
      headers,
      signal,
    });
  } catch {
    // fetch 的原生超时/取消（AbortError）和真实网络异常在这里统一归一化：
    // 调用方（如 isRecoverableChatSendInterruption）本来就要把两者一视同仁——
    // 都代表"不确定后端有没有收到/在处理"，该去查真实状态而不是直接判失败。
    throw new ApiError(0, DEFAULT_NETWORK_ERROR_MESSAGE);
  } finally {
    cleanup();
  }

  const contentType = res.headers.get('content-type') || '';
  const isJsonResponse = contentType.includes('application/json');
  let body: unknown = null;

  if (res.status !== 204) {
    if (!isJsonResponse) {
      throw new ApiError(
        res.status,
        res.ok
          ? DEFAULT_INVALID_RESPONSE_MESSAGE
          : getPublicErrorMessage(res.status, null, {
              exposeServerErrorMessage,
            }),
      );
    }

    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      throw new ApiError(res.status, DEFAULT_INVALID_RESPONSE_MESSAGE);
    }
  }

  if (!res.ok) {
    throw new ApiError(
      res.status,
      getPublicErrorMessage(res.status, body, { exposeServerErrorMessage }),
    );
  }

  return body as T;
}
