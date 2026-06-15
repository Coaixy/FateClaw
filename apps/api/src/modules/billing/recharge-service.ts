import crypto from 'node:crypto';

import type {
  CreateRechargeOrderResponseDto,
  RechargeOrderDto,
  RechargeStatsDto,
} from '@fateclaw/contracts/billing';

import {
  getRechargePaymentConfig,
  getRechargeOrderByTradeId,
  getRechargeOrderByTradeIdForUser,
  getRechargeStatsByUserId,
  getUserById,
  insertRechargeOrder,
  listRechargeOrdersByUserId,
  markRechargeOrderFailed,
  markRechargeOrderPaymentCreated,
  settleRechargeOrderPaid,
  updateRechargePaymentConfig,
  type RechargeOrderRow,
  type RechargePaymentConfigRow,
  type RechargePayType,
} from '../../infrastructure/db.js';
import { logger } from '../../infrastructure/logger.js';
import {
  toRechargeOrderDto,
  toRechargeOrdersDto,
  toRechargeStatsDto,
} from '../../contracts-adapter/billing-contract.js';
import { fail, ok, type ServiceResult } from '../../shared/service-result.js';
import {
  createEpayPayment,
  isSafeEpayUrlPrefix,
  queryEpayOrder,
  verifyEpayNotification,
  type EpayConfig,
} from './epay-client.js';

/**
 * 管理后台展示的充值支付配置。
 */
export interface AdminRechargePaymentConfigDto {
  enabled: boolean;
  min_coins: string;
  max_coins: string;
  epay_url_prefix: string;
  epay_platform_id: number | null;
  epay_merchant_private_key: string;
  epay_platform_public_key: string;
  epay_merchant_key: string;
  notify_url: string;
  return_url: string;
  updated_at: string;
}

/**
 * 管理后台提交的充值支付配置；回调地址由服务端生成，不要求客户端提交。
 */
export type AdminRechargePaymentConfigInput = Omit<
  AdminRechargePaymentConfigDto,
  'updated_at' | 'notify_url' | 'return_url'
> &
  Partial<Pick<AdminRechargePaymentConfigDto, 'notify_url' | 'return_url'>>;

/**
 * 当前请求上下文推导出的充值回调地址。
 */
export interface RechargeCallbackUrls {
  notifyUrl: string;
  returnUrl: string;
}

interface ParsedRechargeAmount {
  amountCoins: number;
  providerMoney: string;
}

type EpayBaseConfig = Pick<
  EpayConfig,
  | 'urlPrefix'
  | 'platformId'
  | 'merchantPrivateKey'
  | 'platformPublicKey'
  | 'merchantKey'
>;

// 充值开关和支付密钥统一走数据库配置；回调地址由请求域名动态生成，不再人工维护。
function resolveEpayBaseConfig(
  paymentConfig: RechargePaymentConfigRow,
): EpayBaseConfig | null {
  if (
    !paymentConfig.enabled ||
    !paymentConfig.epay_url_prefix.trim() ||
    !isSafeEpayUrlPrefix(paymentConfig.epay_url_prefix) ||
    !paymentConfig.epay_platform_id ||
    paymentConfig.epay_platform_id <= 0 ||
    !paymentConfig.epay_merchant_private_key.trim() ||
    !paymentConfig.epay_platform_public_key.trim() ||
    !paymentConfig.epay_merchant_key.trim()
  ) {
    return null;
  }

  return {
    urlPrefix: paymentConfig.epay_url_prefix.trim(),
    platformId: paymentConfig.epay_platform_id,
    merchantPrivateKey: paymentConfig.epay_merchant_private_key,
    platformPublicKey: paymentConfig.epay_platform_public_key,
    merchantKey: paymentConfig.epay_merchant_key,
  };
}

function isHttpUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === 'http:' || url.protocol === 'https:';
}

function roundCoinsToCents(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Object.is(value, -0) ? 0 : Math.round(value * 100) / 100;
}

function resolveEpayConfig(
  paymentConfig: RechargePaymentConfigRow,
  callbackUrls: RechargeCallbackUrls,
): EpayConfig | null {
  const baseConfig = resolveEpayBaseConfig(paymentConfig);
  if (
    !baseConfig ||
    !isHttpUrl(callbackUrls.notifyUrl) ||
    !isHttpUrl(callbackUrls.returnUrl)
  ) {
    return null;
  }

  return {
    ...baseConfig,
    notifyUrl: callbackUrls.notifyUrl,
    returnUrl: callbackUrls.returnUrl,
  };
}

function parseRechargeAmount(
  raw: unknown,
  paymentConfig: Pick<RechargePaymentConfigRow, 'min_coins' | 'max_coins'>,
  opts: { enforceRange?: boolean } = { enforceRange: true },
): ParsedRechargeAmount | string {
  const source =
    typeof raw === 'number' && Number.isFinite(raw)
      ? String(raw)
      : typeof raw === 'string'
        ? raw.trim()
        : '';
  if (!/^\d+(\.\d{1,2})?$/.test(source)) {
    return '补充积分金额必须是正数，最多 2 位小数';
  }

  const numericAmount = Number(source);
  const amountCoins = roundCoinsToCents(numericAmount);
  if (amountCoins <= 0) {
    return '补充积分金额必须是正数，最多 2 位小数';
  }
  const minCoins = Number(paymentConfig.min_coins);
  const maxCoins = Number(paymentConfig.max_coins);

  // 用户创建订单时校验充值区间；支付平台回查金额只做格式和一致性校验。
  if (
    opts.enforceRange !== false &&
    (amountCoins < minCoins || amountCoins > maxCoins)
  ) {
    return `补充积分金额仅支持 ${paymentConfig.min_coins} - ${paymentConfig.max_coins} 积分`;
  }

  return {
    amountCoins,
    // 易支付的 money 字段要求金额字符串，这里只在支付适配层保留两位格式。
    providerMoney: amountCoins.toFixed(2),
  };
}

function normalizePayType(raw: unknown): RechargePayType | null {
  if (raw === 'alipay') return 'alipay';
  if (raw === 'wechat' || raw === 'wxpay') return 'wechat';
  return null;
}

function isSuccessfulEpayNotification(
  payload: Record<string, string>,
): boolean {
  const status = payload.status;
  if (status?.trim() === '1') return true;

  // 易支付异步通知使用 trade_status，查单接口才返回 status=1。
  return payload.trade_status?.trim().toUpperCase() === 'TRADE_SUCCESS';
}

function generateRechargeTradeId(): string {
  return `rc${Date.now()}${crypto.randomInt(100000, 1000000)}`;
}

function ensureStringRecord(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)]),
  );
}

function validateProviderAmount(
  order: RechargeOrderRow,
  paymentConfig: Pick<RechargePaymentConfigRow, 'min_coins' | 'max_coins'>,
  providerMoney: string | undefined,
): ServiceResult<null> {
  if (!providerMoney) return ok(null);
  const parsed = parseRechargeAmount(providerMoney, paymentConfig, {
    enforceRange: false,
  });
  if (typeof parsed === 'string') {
    return fail(400, '支付平台返回的金额格式异常');
  }
  if (parsed.amountCoins !== roundCoinsToCents(order.amount_coins)) {
    return fail(409, '支付金额和补充积分订单不一致，请联系管理员处理');
  }
  return ok(null);
}

/**
 * 将数据库充值配置转换为管理端 DTO。
 */
export function toAdminRechargePaymentConfigDto(
  row: RechargePaymentConfigRow,
  callbackUrls: RechargeCallbackUrls,
): AdminRechargePaymentConfigDto {
  return {
    enabled: row.enabled,
    min_coins: row.min_coins,
    max_coins: row.max_coins,
    epay_url_prefix: row.epay_url_prefix,
    epay_platform_id: row.epay_platform_id,
    epay_merchant_private_key: row.epay_merchant_private_key,
    epay_platform_public_key: row.epay_platform_public_key,
    epay_merchant_key: row.epay_merchant_key,
    notify_url: callbackUrls.notifyUrl,
    return_url: callbackUrls.returnUrl,
    updated_at: row.updated_at,
  };
}

/**
 * 读取管理端充值配置，并附带服务端生成的回调地址。
 */
export async function getAdminRechargePaymentConfig(
  callbackUrls: RechargeCallbackUrls,
): Promise<AdminRechargePaymentConfigDto> {
  return toAdminRechargePaymentConfigDto(
    await getRechargePaymentConfig(),
    callbackUrls,
  );
}

/**
 * 更新管理端充值配置；回调地址由服务端生成后写入数据库用于兼容旧字段。
 */
export async function updateAdminRechargePaymentConfig(
  input: AdminRechargePaymentConfigInput,
  callbackUrls: RechargeCallbackUrls,
): Promise<AdminRechargePaymentConfigDto> {
  const saved = await updateRechargePaymentConfig({
    enabled: input.enabled,
    minCoins: input.min_coins,
    maxCoins: input.max_coins,
    epayUrlPrefix: input.epay_url_prefix.trim(),
    epayPlatformId: input.epay_platform_id,
    epayMerchantPrivateKey: input.epay_merchant_private_key,
    epayPlatformPublicKey: input.epay_platform_public_key,
    epayMerchantKey: input.epay_merchant_key.trim(),
    notifyUrl: callbackUrls.notifyUrl,
    returnUrl: callbackUrls.returnUrl,
  });
  return toAdminRechargePaymentConfigDto(saved, callbackUrls);
}

/**
 * 为当前用户创建充值单，并向易支付创建支付会话。
 */
export async function createRechargeOrderForUser(input: {
  userId: string;
  amountCoins: unknown;
  payType: unknown;
  clientIp: string;
  callbackUrls: RechargeCallbackUrls;
}): Promise<ServiceResult<CreateRechargeOrderResponseDto>> {
  const paymentConfig = await getRechargePaymentConfig();
  const config = resolveEpayConfig(paymentConfig, input.callbackUrls);
  if (!config) {
    return fail(503, '补充积分暂未开放，请联系管理员配置支付');
  }

  const payType = normalizePayType(input.payType);
  if (!payType) {
    return fail(400, '支付方式仅支持支付宝或微信');
  }

  const parsedAmount = parseRechargeAmount(input.amountCoins, paymentConfig);
  if (typeof parsedAmount === 'string') {
    return fail(400, parsedAmount);
  }

  const user = await getUserById(input.userId);
  if (!user) {
    return fail(404, '用户不存在');
  }

  const tradeId = generateRechargeTradeId();
  await insertRechargeOrder({
    id: `ro-${crypto.randomUUID()}`,
    userId: user.id,
    tradeId,
    payType,
    amountCoins: parsedAmount.amountCoins,
    metadata: {
      client_ip: input.clientIp,
    },
  });

  try {
    const response = await createEpayPayment(config, {
      tradeId,
      name: `命枢补充积分 ${parsedAmount.amountCoins} 积分`,
      money: parsedAmount.providerMoney,
      payType,
      clientIp: input.clientIp || '127.0.0.1',
    });

    if (response.code !== 0 || !response.pay_info) {
      const reason = response.msg || '创建支付单失败';
      await markRechargeOrderFailed(tradeId, reason);
      return fail(502, reason);
    }

    const order = await markRechargeOrderPaymentCreated({
      tradeId,
      providerTradeId: response.trade_no ?? null,
      payUrl: response.pay_info,
      metadata: {
        provider_create_response: {
          code: response.code,
          trade_no: response.trade_no ?? null,
          pay_type: response.pay_type ?? null,
          timestamp: response.timestamp ?? null,
        },
      },
    });

    return ok({
      order: toRechargeOrderDto(order),
      pay_url: order.pay_url ?? response.pay_info,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : '创建支付单失败';
    await markRechargeOrderFailed(tradeId, message);
    logger.warn({ err, tradeId }, '创建充值支付单失败');
    return fail(502, '创建支付单失败，请稍后重试');
  }
}

/**
 * 查询用户最近的充值订单。
 */
export async function listRechargeOrdersForUser(
  userId: string,
): Promise<ServiceResult<RechargeOrderDto[]>> {
  const user = await getUserById(userId);
  if (!user) {
    return fail(404, '用户不存在');
  }
  return ok(toRechargeOrdersDto(await listRechargeOrdersByUserId(user.id, 20)));
}

/**
 * 查询用户充值统计汇总。
 */
export async function getRechargeStatsForUser(
  userId: string,
): Promise<ServiceResult<RechargeStatsDto>> {
  const user = await getUserById(userId);
  if (!user) {
    return fail(404, '用户不存在');
  }
  return ok(toRechargeStatsDto(await getRechargeStatsByUserId(user.id)));
}

/**
 * 用户支付完成后主动查询平台状态，并在已支付时补偿入账。
 */
export async function syncRechargeOrderForUser(input: {
  userId: string;
  tradeId: string;
}): Promise<ServiceResult<RechargeOrderDto>> {
  const order = await getRechargeOrderByTradeIdForUser(
    input.userId,
    input.tradeId,
  );
  if (!order) {
    return fail(404, '补充积分订单不存在');
  }
  if (order.status === 'paid') {
    return ok(toRechargeOrderDto(order));
  }

  const paymentConfig = await getRechargePaymentConfig();
  const config = resolveEpayBaseConfig(paymentConfig);
  if (!config) {
    return ok(toRechargeOrderDto(order));
  }

  try {
    const response = await queryEpayOrder(config, order.trade_id);
    if (response.code !== 1) {
      logger.warn(
        {
          tradeId: input.tradeId,
          providerCode: response.code,
          providerMessage: response.msg,
        },
        '查询充值单支付状态失败，保留本地状态',
      );
      return ok(toRechargeOrderDto(order));
    }
    if (response.status !== 1) {
      return ok(toRechargeOrderDto(order));
    }

    const amountCheck = validateProviderAmount(
      order,
      paymentConfig,
      response.money,
    );
    if (!amountCheck.ok) {
      return amountCheck;
    }

    const settled = await settleRechargeOrderPaid({
      tradeId: order.trade_id,
      providerTradeId: response.trade_no ?? order.provider_trade_id,
      payType: normalizePayType(response.type) ?? order.pay_type,
      notifyPayload: { source: 'manual_sync', response },
    });
    return ok(toRechargeOrderDto(settled));
  } catch (err) {
    logger.warn(
      { err, tradeId: input.tradeId },
      '同步充值单状态失败，保留本地状态',
    );
    return ok(toRechargeOrderDto(order));
  }
}

/**
 * 处理易支付异步通知，验签、校验金额并幂等入账。
 */
export async function handleRechargeNotification(
  rawPayload: unknown,
): Promise<ServiceResult<RechargeOrderDto>> {
  const paymentConfig = await getRechargePaymentConfig();
  const config = resolveEpayBaseConfig(paymentConfig);
  if (!config) {
    return fail(503, '补充积分暂未开放');
  }

  const payload = ensureStringRecord(rawPayload);
  if (!verifyEpayNotification(config.platformPublicKey, payload)) {
    return fail(400, '充值通知验签失败');
  }

  const tradeId = payload.out_trade_no;
  if (!tradeId) {
    return fail(400, '充值通知缺少订单号');
  }
  if (payload.pid && Number(payload.pid) !== config.platformId) {
    return fail(400, '充值通知商户号不匹配');
  }

  const order = await getRechargeOrderByTradeId(tradeId);
  if (!order) {
    return fail(404, '补充积分订单不存在');
  }

  if (!isSuccessfulEpayNotification(payload)) {
    return ok(toRechargeOrderDto(order));
  }

  const amountCheck = validateProviderAmount(
    order,
    paymentConfig,
    payload.money,
  );
  if (!amountCheck.ok) {
    return amountCheck;
  }

  const settled = await settleRechargeOrderPaid({
    tradeId,
    providerTradeId:
      payload.trade_no || payload.api_trade_no || payload.bill_trade_no || null,
    payType: normalizePayType(payload.type) ?? order.pay_type,
    notifyPayload: payload,
  });

  return ok(toRechargeOrderDto(settled));
}
