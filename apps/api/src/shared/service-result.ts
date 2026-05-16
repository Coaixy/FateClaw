/**
 * 统一封装 service 层返回结果，便于 HTTP route 只处理协议与状态码。
 */

export type ServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; statusCode: number; error: string };

export function ok<T>(data: T): ServiceResult<T> {
  return { ok: true, data };
}

export function fail(statusCode: number, error: string): ServiceResult<never> {
  return { ok: false, statusCode, error };
}
