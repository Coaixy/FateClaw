import type { FastifyRequest } from 'fastify';

import { PUBLIC_BASE_URL } from '../../infrastructure/config.js';

const RECHARGE_NOTIFY_PATH = '/api/billing/recharge/notify';
const RECHARGE_RETURN_PATH = '/wallet';

/**
 * 第三方支付平台需要回传或跳转的公开 URL。
 */
export interface PaymentCallbackUrls {
  notifyUrl: string;
  returnUrl: string;
}

function firstHeaderValue(value: string | string[] | undefined): string {
  const first = Array.isArray(value) ? value[0] : value;
  return first?.split(',')[0]?.trim() ?? '';
}

function normalizeProtocol(value: string): 'http' | 'https' {
  return value.trim().toLowerCase().replace(/:$/, '') === 'https'
    ? 'https'
    : 'http';
}

function resolveRequestOrigin(request: FastifyRequest): string {
  const forwardedHost = firstHeaderValue(request.headers['x-forwarded-host']);
  const host = forwardedHost || firstHeaderValue(request.headers.host);
  if (!host) return '';

  const forwardedProtocol = firstHeaderValue(
    request.headers['x-forwarded-proto'],
  );
  const protocol = forwardedProtocol
    ? normalizeProtocol(forwardedProtocol)
    : request.protocol;

  const origin = `${protocol}://${host}`;
  if (!URL.canParse(origin)) return '';
  const url = new URL(origin);
  return `${url.protocol}//${url.host}`;
}

function buildAbsoluteUrl(origin: string, path: string): string {
  return new URL(path, `${origin}/`).toString();
}

/**
 * 根据部署公开地址或当前请求域名生成充值回调地址。
 *
 * PUBLIC_BASE_URL 用于生产反代或多域名部署的显式覆盖；未配置时使用
 * 当前请求 Host，保证开发环境和同源部署不需要额外手填。
 */
export function resolvePaymentCallbackUrls(
  request: FastifyRequest,
): PaymentCallbackUrls {
  const origin = PUBLIC_BASE_URL || resolveRequestOrigin(request);
  return {
    notifyUrl: origin
      ? buildAbsoluteUrl(origin, RECHARGE_NOTIFY_PATH)
      : RECHARGE_NOTIFY_PATH,
    returnUrl: origin
      ? buildAbsoluteUrl(origin, RECHARGE_RETURN_PATH)
      : RECHARGE_RETURN_PATH,
  };
}
