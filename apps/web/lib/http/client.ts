import type { ApiErrorResponse } from '@fateclaw/contracts/common';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || '';
const DEFAULT_SERVER_ERROR_MESSAGE = '服务暂时不可用，请稍后重试';
const DEFAULT_NETWORK_ERROR_MESSAGE = '网络连接失败，请检查服务是否正常后重试';
const DEFAULT_INVALID_RESPONSE_MESSAGE = '服务返回异常，请稍后重试';

type ApiErrorBody = ApiErrorResponse;

interface RequestJsonOptions extends RequestInit {
  exposeServerErrorMessage?: boolean;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
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
  const { exposeServerErrorMessage = false, ...fetchOptions } = options;
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

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...fetchOptions,
      headers,
    });
  } catch {
    throw new ApiError(0, DEFAULT_NETWORK_ERROR_MESSAGE);
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

export async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  return requestJson<T>(path, options);
}
