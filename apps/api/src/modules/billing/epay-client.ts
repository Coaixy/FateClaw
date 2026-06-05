import crypto from 'node:crypto';

export type EpayPayType = 'alipay' | 'wechat';

export interface EpayConfig {
  urlPrefix: string;
  platformId: number;
  merchantPrivateKey: string;
  platformPublicKey: string;
  merchantKey: string;
  notifyUrl: string;
  returnUrl: string;
}

export interface EpayCreatePaymentInput {
  tradeId: string;
  name: string;
  money: string;
  payType: EpayPayType;
  clientIp: string;
}

export interface EpayCreatePaymentResponse {
  code: number;
  msg?: string;
  trade_no?: string;
  pay_type?: string;
  pay_info?: string;
  timestamp?: string;
  sign_type?: string;
  sign?: string;
}

export interface EpayQueryOrderResponse {
  code: number;
  msg?: string;
  trade_no?: string;
  out_trade_no?: string;
  api_trade_no?: string;
  bill_trade_no?: string;
  type?: string;
  pid?: number;
  addtime?: string;
  endtime?: string;
  name?: string;
  money?: string;
  status?: number;
  param?: string;
  buyer?: string;
  payurl?: string;
}

function isLocalDevelopmentEnvironment(): boolean {
  return (
    process.env.NODE_ENV === 'development' ||
    process.env.NODE_ENV === 'test' ||
    Boolean(process.env.VITEST)
  );
}

function isLocalhostUrl(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]'
  );
}

/**
 * 校验易支付网关地址是否适合传输商户密钥。
 *
 * @param urlPrefix 管理后台配置的易支付网关前缀。
 * @returns 生产可用的 HTTPS 地址，或开发/测试环境的本机 HTTP 地址时返回 true。
 * @remarks 查询接口会把 key 放进 query string，非 HTTPS 只能用于本机联调。
 */
export function isSafeEpayUrlPrefix(urlPrefix: string): boolean {
  const trimmed = urlPrefix.trim();
  if (!URL.canParse(trimmed)) return false;
  const url = new URL(trimmed);
  if (url.protocol === 'https:') return true;
  return (
    url.protocol === 'http:' &&
    isLocalDevelopmentEnvironment() &&
    isLocalhostUrl(url)
  );
}

function assertSafeEpayUrlPrefix(urlPrefix: string): void {
  if (!isSafeEpayUrlPrefix(urlPrefix)) {
    throw new Error('易支付网关地址必须使用 HTTPS，本机开发测试除外');
  }
}

function normalizeUrlPrefix(urlPrefix: string): string {
  return urlPrefix.endsWith('/') ? urlPrefix : `${urlPrefix}/`;
}

function collectSignData(data: Record<string, string>): string {
  return Object.entries(data)
    .filter(([, value]) => value !== '')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function pemCandidates(rawKey: string, labels: string[]): string[] {
  const normalized = rawKey.trim().replace(/\\n/g, '\n');
  if (normalized.includes('-----BEGIN ')) {
    return [normalized];
  }
  const compact = normalized.replace(/\s+/g, '');
  const body = compact.match(/.{1,64}/g)?.join('\n') ?? compact;
  return labels.map(
    (label) => `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`,
  );
}

function signWithPrivateKey(data: string, privateKey: string): string {
  let lastError: unknown;
  for (const candidate of pemCandidates(privateKey, [
    'PRIVATE KEY',
    'RSA PRIVATE KEY',
  ])) {
    try {
      return crypto
        .sign('RSA-SHA256', Buffer.from(data), candidate)
        .toString('base64');
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('易支付私钥无效');
}

function verifyWithPublicKey(
  data: string,
  signature: string,
  publicKey: string,
): boolean {
  for (const candidate of pemCandidates(publicKey, [
    'PUBLIC KEY',
    'RSA PUBLIC KEY',
  ])) {
    try {
      if (
        crypto.verify(
          'RSA-SHA256',
          Buffer.from(data),
          candidate,
          Buffer.from(signature, 'base64'),
        )
      ) {
        return true;
      }
    } catch {
      // 继续尝试另一种 PEM 头，兼容平台配置给出的裸 key。
    }
  }
  return false;
}

function toProviderPayType(payType: EpayPayType): string {
  return payType === 'wechat' ? 'wxpay' : 'alipay';
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`易支付请求失败：HTTP ${response.status}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error('易支付返回了非 JSON 响应', { cause: err });
  }
}

export async function createEpayPayment(
  config: EpayConfig,
  input: EpayCreatePaymentInput,
): Promise<EpayCreatePaymentResponse> {
  assertSafeEpayUrlPrefix(config.urlPrefix);

  const data: Record<string, string> = {
    pid: String(config.platformId),
    method: 'jump',
    type: toProviderPayType(input.payType),
    out_trade_no: input.tradeId,
    notify_url: config.notifyUrl,
    return_url: config.returnUrl,
    name: input.name,
    money: input.money,
    clientip: input.clientIp,
    timestamp: String(Math.floor(Date.now() / 1000)),
  };

  data.sign = signWithPrivateKey(
    collectSignData(data),
    config.merchantPrivateKey,
  );
  data.sign_type = 'RSA';

  const response = await fetch(
    `${normalizeUrlPrefix(config.urlPrefix)}api/pay/create`,
    {
      method: 'POST',
      body: new URLSearchParams(data),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    },
  );

  return readJsonResponse<EpayCreatePaymentResponse>(response);
}

export async function queryEpayOrder(
  config: Pick<EpayConfig, 'urlPrefix' | 'platformId' | 'merchantKey'>,
  tradeId: string,
): Promise<EpayQueryOrderResponse> {
  assertSafeEpayUrlPrefix(config.urlPrefix);

  const url = new URL(`${normalizeUrlPrefix(config.urlPrefix)}api.php`);
  url.searchParams.set('act', 'order');
  url.searchParams.set('pid', String(config.platformId));
  url.searchParams.set('key', config.merchantKey);
  url.searchParams.set('out_trade_no', tradeId);

  const response = await fetch(url);
  return readJsonResponse<EpayQueryOrderResponse>(response);
}

export function verifyEpayNotification(
  platformPublicKey: string,
  payload: Record<string, string>,
): boolean {
  const { sign, sign_type: _signType, ...rest } = payload;
  if (!sign) return false;
  return verifyWithPublicKey(collectSignData(rest), sign, platformPublicKey);
}
