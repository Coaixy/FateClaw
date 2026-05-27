import crypto from 'node:crypto';

import type {
  CreateRechargeOrderResponseDto,
  RechargeOrderDto,
  RechargeStatsDto,
} from '@fateclaw/contracts/billing';

import { POINTS_PER_YUAN } from '../../infrastructure/config.js';
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
  queryEpayOrder,
  verifyEpayNotification,
  type EpayConfig,
} from './epay-client.js';

export interface AdminRechargePaymentConfigDto {
  enabled: boolean;
  min_yuan: string;
  max_yuan: string;
  epay_url_prefix: string;
  epay_platform_id: number | null;
  epay_merchant_private_key: string;
  epay_platform_public_key: string;
  epay_merchant_key: string;
  notify_url: string;
  return_url: string;
  updated_at: string;
}

export type AdminRechargePaymentConfigInput = Omit<
  AdminRechargePaymentConfigDto,
  'updated_at'
>;

interface ParsedRechargeAmount {
  amountYuan: string;
  amountPoints: number;
}

// 充值开关和支付密钥统一走数据库配置，业务层只关心是否能形成完整易支付配置。
function resolveEpayConfig(
  paymentConfig: RechargePaymentConfigRow,
): EpayConfig | null {
  if (
    !paymentConfig.enabled ||
    !paymentConfig.epay_url_prefix.trim() ||
    !paymentConfig.epay_platform_id ||
    paymentConfig.epay_platform_id <= 0 ||
    !paymentConfig.epay_merchant_private_key.trim() ||
    !paymentConfig.epay_platform_public_key.trim() ||
    !paymentConfig.epay_merchant_key.trim() ||
    !paymentConfig.notify_url.trim() ||
    !paymentConfig.return_url.trim()
  ) {
    return null;
  }

  return {
    urlPrefix: paymentConfig.epay_url_prefix.trim(),
    platformId: paymentConfig.epay_platform_id,
    merchantPrivateKey: paymentConfig.epay_merchant_private_key,
    platformPublicKey: paymentConfig.epay_platform_public_key,
    merchantKey: paymentConfig.epay_merchant_key,
    notifyUrl: paymentConfig.notify_url.trim(),
    returnUrl: paymentConfig.return_url.trim(),
  };
}

function parseRechargeAmount(
  raw: unknown,
  paymentConfig: Pick<RechargePaymentConfigRow, 'min_yuan' | 'max_yuan'>,
  opts: { enforceRange?: boolean } = { enforceRange: true },
): ParsedRechargeAmount | string {
  const source =
    typeof raw === 'number' && Number.isFinite(raw)
      ? String(raw)
      : typeof raw === 'string'
        ? raw.trim()
        : '';
  if (!/^\d+(\.\d{1,2})?$/.test(source)) {
    return '充值金额必须是最多两位小数的正数';
  }

  const [yuanPart, centPart = ''] = source.split('.');
  const yuan = Number.parseInt(yuanPart, 10);
  const cents = Number.parseInt(centPart.padEnd(2, '0') || '0', 10);
  const amountPoints = yuan * POINTS_PER_YUAN + cents;
  const min = Number(paymentConfig.min_yuan);
  const max = Number(paymentConfig.max_yuan);
  const minPoints = Math.round(min * POINTS_PER_YUAN);
  const maxPoints = Math.round(max * POINTS_PER_YUAN);

  // 用户创建订单时校验充值区间；支付平台回查金额只做格式和一致性校验。
  if (
    opts.enforceRange !== false &&
    (amountPoints < minPoints || amountPoints > maxPoints)
  ) {
    return `充值金额仅支持 ¥${paymentConfig.min_yuan} - ¥${paymentConfig.max_yuan}`;
  }

  return {
    amountYuan: (amountPoints / POINTS_PER_YUAN).toFixed(2),
    amountPoints,
  };
}

function normalizePayType(raw: unknown): RechargePayType | null {
  if (raw === 'alipay') return 'alipay';
  if (raw === 'wechat' || raw === 'wxpay') return 'wechat';
  return null;
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
  paymentConfig: Pick<RechargePaymentConfigRow, 'min_yuan' | 'max_yuan'>,
  providerMoney: string | undefined,
): ServiceResult<null> {
  if (!providerMoney) return ok(null);
  const parsed = parseRechargeAmount(providerMoney, paymentConfig, {
    enforceRange: false,
  });
  if (typeof parsed === 'string') {
    return fail(400, '支付平台返回的金额格式异常');
  }
  if (parsed.amountPoints !== order.amount_points) {
    return fail(409, '支付金额和充值单不一致，请联系管理员处理');
  }
  return ok(null);
}

export function toAdminRechargePaymentConfigDto(
  row: RechargePaymentConfigRow,
): AdminRechargePaymentConfigDto {
  return {
    enabled: row.enabled,
    min_yuan: row.min_yuan,
    max_yuan: row.max_yuan,
    epay_url_prefix: row.epay_url_prefix,
    epay_platform_id: row.epay_platform_id,
    epay_merchant_private_key: row.epay_merchant_private_key,
    epay_platform_public_key: row.epay_platform_public_key,
    epay_merchant_key: row.epay_merchant_key,
    notify_url: row.notify_url,
    return_url: row.return_url,
    updated_at: row.updated_at,
  };
}

export async function getAdminRechargePaymentConfig(): Promise<AdminRechargePaymentConfigDto> {
  return toAdminRechargePaymentConfigDto(await getRechargePaymentConfig());
}

export async function updateAdminRechargePaymentConfig(
  input: AdminRechargePaymentConfigInput,
): Promise<AdminRechargePaymentConfigDto> {
  const saved = await updateRechargePaymentConfig({
    enabled: input.enabled,
    minYuan: input.min_yuan,
    maxYuan: input.max_yuan,
    epayUrlPrefix: input.epay_url_prefix.trim(),
    epayPlatformId: input.epay_platform_id,
    epayMerchantPrivateKey: input.epay_merchant_private_key,
    epayPlatformPublicKey: input.epay_platform_public_key,
    epayMerchantKey: input.epay_merchant_key.trim(),
    notifyUrl: input.notify_url.trim(),
    returnUrl: input.return_url.trim(),
  });
  return toAdminRechargePaymentConfigDto(saved);
}

export async function createRechargeOrderForUser(input: {
  userId: string;
  amountYuan: unknown;
  payType: unknown;
  clientIp: string;
}): Promise<ServiceResult<CreateRechargeOrderResponseDto>> {
  const paymentConfig = await getRechargePaymentConfig();
  const config = resolveEpayConfig(paymentConfig);
  if (!config) {
    return fail(503, '充值暂未开放，请联系管理员配置支付');
  }

  const payType = normalizePayType(input.payType);
  if (!payType) {
    return fail(400, '支付方式仅支持支付宝或微信');
  }

  const parsedAmount = parseRechargeAmount(input.amountYuan, paymentConfig);
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
    amountYuan: parsedAmount.amountYuan,
    amountPoints: parsedAmount.amountPoints,
    metadata: {
      client_ip: input.clientIp,
    },
  });

  try {
    const response = await createEpayPayment(config, {
      tradeId,
      name: `命枢充值 ${parsedAmount.amountYuan} 元`,
      money: parsedAmount.amountYuan,
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

export async function listRechargeOrdersForUser(
  userId: string,
): Promise<ServiceResult<RechargeOrderDto[]>> {
  const user = await getUserById(userId);
  if (!user) {
    return fail(404, '用户不存在');
  }
  return ok(toRechargeOrdersDto(await listRechargeOrdersByUserId(user.id, 20)));
}

export async function getRechargeStatsForUser(
  userId: string,
): Promise<ServiceResult<RechargeStatsDto>> {
  const user = await getUserById(userId);
  if (!user) {
    return fail(404, '用户不存在');
  }
  return ok(toRechargeStatsDto(await getRechargeStatsByUserId(user.id)));
}

export async function syncRechargeOrderForUser(input: {
  userId: string;
  tradeId: string;
}): Promise<ServiceResult<RechargeOrderDto>> {
  const paymentConfig = await getRechargePaymentConfig();
  const config = resolveEpayConfig(paymentConfig);
  if (!config) {
    return fail(503, '充值暂未开放，请联系管理员配置支付');
  }

  const order = await getRechargeOrderByTradeIdForUser(
    input.userId,
    input.tradeId,
  );
  if (!order) {
    return fail(404, '充值单不存在');
  }
  if (order.status === 'paid') {
    return ok(toRechargeOrderDto(order));
  }

  try {
    const response = await queryEpayOrder(config, order.trade_id);
    if (response.code !== 1) {
      return fail(502, response.msg || '查询支付状态失败');
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
    logger.warn({ err, tradeId: input.tradeId }, '同步充值单状态失败');
    return fail(502, '同步支付状态失败，请稍后重试');
  }
}

export async function handleRechargeNotification(
  rawPayload: unknown,
): Promise<ServiceResult<RechargeOrderDto>> {
  const paymentConfig = await getRechargePaymentConfig();
  const config = resolveEpayConfig(paymentConfig);
  if (!config) {
    return fail(503, '充值暂未开放');
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
    return fail(404, '充值单不存在');
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
