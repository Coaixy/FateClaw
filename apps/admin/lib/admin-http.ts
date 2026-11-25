const API_BASE = process.env.NEXT_PUBLIC_API_BASE || '';
const ADMIN_KEY_STORAGE_KEY = 'admin_key';
const DEFAULT_SERVER_ERROR_MESSAGE = '服务暂时不可用，请稍后重试';
const DEFAULT_NETWORK_ERROR_MESSAGE = '网络连接失败，请检查服务是否正常后重试';
const DEFAULT_INVALID_RESPONSE_MESSAGE = '服务返回异常，请稍后重试';

export class AdminApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function readAdminKeyFrom(storage?: Storage | null): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(ADMIN_KEY_STORAGE_KEY);
  } catch (error) {
    if (error instanceof DOMException) return null;
    throw error;
  }
}

function writeAdminKeyTo(storage: Storage | null | undefined, key: string) {
  if (!storage) return;
  try {
    storage.setItem(ADMIN_KEY_STORAGE_KEY, key);
  } catch (error) {
    if (error instanceof DOMException) return;
    throw error;
  }
}

function removeAdminKeyFrom(storage?: Storage | null) {
  if (!storage) return;
  try {
    storage.removeItem(ADMIN_KEY_STORAGE_KEY);
  } catch (error) {
    if (error instanceof DOMException) return;
    throw error;
  }
}

export function getAdminKey(): string | null {
  if (typeof window === 'undefined') return null;
  return (
    readAdminKeyFrom(window.sessionStorage) ??
    readAdminKeyFrom(window.localStorage)
  );
}

export function hasPersistentAdminKey(): boolean {
  if (typeof window === 'undefined') return false;
  return readAdminKeyFrom(window.localStorage) !== null;
}

export function setAdminKey(key: string, persist = false) {
  if (typeof window === 'undefined') return;
  removeAdminKeyFrom(window.sessionStorage);
  removeAdminKeyFrom(window.localStorage);
  writeAdminKeyTo(persist ? window.localStorage : window.sessionStorage, key);
}

export function clearAdminKey() {
  if (typeof window === 'undefined') return;
  removeAdminKeyFrom(window.sessionStorage);
  removeAdminKeyFrom(window.localStorage);
}

export function isAdminUnauthorizedError(
  error: unknown,
): error is AdminApiError {
  return error instanceof AdminApiError && error.status === 401;
}

export function isAdminForbiddenError(error: unknown): error is AdminApiError {
  return error instanceof AdminApiError && error.status === 403;
}

/**
 * 将管理端 API 错误转换成页面可直接展示的中文提示。
 */
export function formatAdminErrorMessage(
  error: unknown,
  fallback: string,
): string {
  if (isAdminForbiddenError(error)) return '无权访问该管理功能';
  return error instanceof Error ? error.message : fallback;
}

export async function adminRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const key = getAdminKey();

  const headers: Record<string, string> = {
    ...((options.headers as Record<string, string>) || {}),
  };

  if (options.body) {
    headers['Content-Type'] = 'application/json';
  }

  if (key) {
    headers['X-Admin-Key'] = key;
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
    });
  } catch {
    throw new AdminApiError(0, DEFAULT_NETWORK_ERROR_MESSAGE);
  }

  // 检测非 JSON 响应（后端未运行或返回了 HTML 页面）
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new AdminApiError(
      res.status,
      res.ok
        ? DEFAULT_INVALID_RESPONSE_MESSAGE
        : res.status >= 500
          ? DEFAULT_SERVER_ERROR_MESSAGE
          : '后端接口返回了非 JSON 响应，请确认服务是否正常运行',
    );
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new AdminApiError(
      res.status,
      res.status >= 500
        ? DEFAULT_SERVER_ERROR_MESSAGE
        : body.error || `请求失败 (${res.status})`,
    );
  }

  return res.json() as Promise<T>;
}
