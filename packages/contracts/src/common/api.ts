/**
 * HTTP 公共响应契约。
 * 这里只放跨端共享的稳定结构，不放运行时实现。
 */

export interface ApiErrorResponse {
  error: string;
}

export interface SuccessResponse {
  success: true;
}

export interface OkResponse {
  ok: true;
}

export interface TextResponse {
  text: string;
}
