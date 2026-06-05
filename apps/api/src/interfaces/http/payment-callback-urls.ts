import type { FastifyRequest } from 'fastify';

import {
  PAYMENT_CALLBACK_ALLOWED_HOSTS,
  PUBLIC_BASE_URL,
} from '../../infrastructure/config.js';

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

function isLocalDevelopmentEnvironment(): boolean {
  return (
    process.env.NODE_ENV === 'development' ||
    process.env.NODE_ENV === 'test' ||
    Boolean(process.env.VITEST)
  );
}

function normalizeRequestHost(value: string): string {
  if (!value || /[\s/@\\?#]/.test(value)) return '';
  const origin = `https://${value}`;
  if (!URL.canParse(origin)) return '';
  const url = new URL(origin);
  if (url.pathname !== '/' || url.search || url.hash) return '';
  return url.host.toLowerCase();
}

function parseHost(host: string): URL | null {
  if (!host || !URL.canParse(`https://${host}`)) return null;
  return new URL(`https://${host}`);
}

function isLocalhostHost(host: string): boolean {
  const url = parseHost(host);
  if (!url) return false;
  const hostname = url.hostname.toLowerCase();
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]'
  );
}

function isAllowedCallbackHost(host: string): boolean {
  const url = parseHost(host);
  if (!url) return false;
  return PAYMENT_CALLBACK_ALLOWED_HOSTS.some(
    (allowedHost) =>
      allowedHost === url.host.toLowerCase() ||
      allowedHost === url.hostname.toLowerCase(),
  );
}

function isTrustedCallbackHost(host: string): boolean {
  if (isAllowedCallbackHost(host)) return true;
  // 本机 Host 只作为开发/测试兜底；线上必须配置 PUBLIC_BASE_URL 或白名单。
  return isLocalDevelopmentEnvironment() && isLocalhostHost(host);
}

function resolveRequestOrigin(request: FastifyRequest): string {
  const forwardedHost = firstHeaderValue(request.headers['x-forwarded-host']);
  const host = normalizeRequestHost(
    forwardedHost || firstHeaderValue(request.headers.host),
  );
  if (!host) return '';
  if (!isTrustedCallbackHost(host)) return '';

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
 * PUBLIC_BASE_URL 用于生产反代或多域名部署的显式覆盖；未配置时只接受
 * 白名单 Host 或开发本机 Host，避免攻击者通过 Host 头污染平台回调地址。
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
