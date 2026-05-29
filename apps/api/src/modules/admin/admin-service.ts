/**
 * 管理后台服务层。
 *
 * 对外暴露管理端需要的领域能力，避免 route 直接拼装
 * 数据库、系统配置与套餐模块的细节。
 */

import crypto from 'node:crypto';

import bcrypt from 'bcryptjs';

import {
  adjustUserPurchasedBalance,
  approveWithdrawal,
  createUser,
  decryptSensitive,
  deleteConversationLogsByAccountIds,
  deleteUser,
  getAccountsByUserId,
  getActiveTaskCountForUser,
  getAdminGlobalStats,
  getAllSkillGlobalConfigs,
  getAllUsers,
  getChatSessionsForAdmin,
  getConversationLogById,
  getConversationLogByRequestId,
  getConversationLogSummaries,
  getCustomSkillForAdmin,
  getCustomSkillsForAdmin,
  getMessagesForAdmin,
  getBalanceGrantsByUserId,
  getTasksForAdmin,
  getUserById,
  getUserByPhone,
  getUserCustomSkillById,
  getWalletTransactionsByUserId,
  grantBonusBalance,
  listAllWithdrawals,
  listBillingRequestReservations,
  markWithdrawalPaid,
  maskIdNumber,
  reconcileStaleBillingReservations,
  rejectWithdrawal,
  setSkillGlobalEnabled,
  setUserCustomSkillAdminState,
} from '../../infrastructure/db.js';
import { getUsageStats } from '../../infrastructure/daily-usage.js';
import {
  createOfficialModel,
  getSystemConfigOverview,
  removeOfficialModel,
  setOfficialModelSecret,
  updateOfficialModel,
} from '../system/system-config.js';
import {
  getMonthlyMeteredBillingSummary,
  getWalletBalanceSummary,
} from '../billing/plans.js';
import {
  getAdminRechargePaymentConfig,
  updateAdminRechargePaymentConfig,
} from '../billing/recharge-service.js';
import { listPaipanRegistry } from '../chat/paipan-registry.js';
import { getWebChatRuntimeId } from '../chat/web-chat-runtime.js';
import {
  isValidMainlandChinaPhone,
  normalizePhoneNumber,
} from '../user/phone.js';
import type { User, UserRole } from '../../shared/types.js';

const ADMIN_CREATE_USER_SALT_ROUNDS = 10;
const ADMIN_CREATE_USER_PASSWORD_MIN_LENGTH = 8;

export {
  adjustUserPurchasedBalance,
  approveWithdrawal,
  createOfficialModel,
  deleteConversationLogsByAccountIds,
  deleteUser,
  getAdminGlobalStats,
  getAdminRechargePaymentConfig,
  getChatSessionsForAdmin,
  getConversationLogById,
  getConversationLogByRequestId,
  getConversationLogSummaries,
  getCustomSkillForAdmin,
  getCustomSkillsForAdmin,
  getMessagesForAdmin,
  getBalanceGrantsByUserId,
  getSystemConfigOverview,
  getTasksForAdmin,
  getUserById,
  getUserCustomSkillById,
  getWalletTransactionsByUserId,
  grantBonusBalance,
  listBillingRequestReservations,
  markWithdrawalPaid,
  reconcileStaleBillingReservations,
  removeOfficialModel,
  rejectWithdrawal,
  setOfficialModelSecret,
  setSkillGlobalEnabled,
  setUserCustomSkillAdminState,
  updateOfficialModel,
  updateAdminRechargePaymentConfig,
};

/**
 * 管理后台按用户清空日志：同时覆盖站内 AI Chat runtime 和用户绑定账号。
 */
export async function deleteConversationLogsForAdminUser(
  userId: string,
): Promise<number> {
  const accounts = await getAccountsByUserId(userId);
  const accountIds = new Set<string>([getWebChatRuntimeId(userId)]);
  for (const account of accounts) {
    accountIds.add(account.id);
  }
  return deleteConversationLogsByAccountIds([...accountIds]);
}

export async function createAdminUser(input: {
  phone: string;
  password: string;
  role: UserRole;
  phoneVerified: boolean;
}): Promise<{ id: string }> {
  const normalizedPhone = normalizePhoneNumber(input.phone);
  if (!isValidMainlandChinaPhone(normalizedPhone)) {
    throw new Error('手机号格式不正确');
  }
  if (input.password.length < ADMIN_CREATE_USER_PASSWORD_MIN_LENGTH) {
    throw new Error(`密码至少 ${ADMIN_CREATE_USER_PASSWORD_MIN_LENGTH} 位`);
  }
  const existing = await getUserByPhone(normalizedPhone);
  if (existing) {
    throw new Error('该手机号已存在');
  }

  const now = new Date().toISOString();
  const user: User = {
    id: crypto.randomUUID(),
    phone: normalizedPhone,
    phone_verified: input.phoneVerified,
    password_hash: await bcrypt.hash(
      input.password,
      ADMIN_CREATE_USER_SALT_ROUNDS,
    ),
    role: input.role,
    purchased_cents: 0,
    bonus_cents: 0,
    earned_cents: 0,
    reserved_cents: 0,
    pending_withdrawal_cents: 0,
    created_at: now,
  };

  try {
    await createUser(user);
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      err.code === '23505'
    ) {
      throw new Error('该手机号已存在');
    }
    throw err;
  }

  return { id: user.id };
}

/**
 * 聚合用户列表页需要的统计信息。
 */
export async function listAdminUsersWithStats(): Promise<
  Array<
    Omit<Awaited<ReturnType<typeof getAllUsers>>[number], 'password_hash'> & {
      account_count: number;
      active_tasks: number;
      usage: Awaited<ReturnType<typeof getUsageStats>>;
      monthly_tokens_used: number;
      estimated_monthly_total_cents: number;
      purchased_cents: number;
      bonus_cents: number;
      earned_cents: number;
      reserved_cents: number;
      available_cents: number;
    }
  >
> {
  const users = await getAllUsers();
  return Promise.all(
    users.map(async ({ password_hash: _passwordHash, ...safe }) => {
      const [accounts, usage, activeTasks, monthlyBilling, wallet] =
        await Promise.all([
          getAccountsByUserId(safe.id),
          getUsageStats(safe.id),
          getActiveTaskCountForUser(safe.id),
          getMonthlyMeteredBillingSummary(safe.id),
          getWalletBalanceSummary(safe.id),
        ]);
      return {
        ...safe,
        account_count: accounts.length,
        active_tasks: activeTasks,
        usage,
        monthly_tokens_used: monthlyBilling.usedTokens,
        estimated_monthly_total_cents: monthlyBilling.chargedCents,
        purchased_cents: wallet.purchasedCents,
        bonus_cents: wallet.bonusCents,
        earned_cents: wallet.earnedCents,
        reserved_cents: wallet.reservedCents,
        available_cents: wallet.availableCents,
      };
    }),
  );
}

/**
 * 聚合单用户详情页需要的统计与账号信息。
 */
export async function getAdminUserDetail(userId: string): Promise<{
  user: Omit<
    NonNullable<Awaited<ReturnType<typeof getUserById>>>,
    'password_hash'
  > & {
    account_count: number;
    active_tasks: number;
    usage: Awaited<ReturnType<typeof getUsageStats>>;
    monthly_tokens_used: number;
    estimated_monthly_total_cents: number;
    purchased_cents: number;
    bonus_cents: number;
    earned_cents: number;
    reserved_cents: number;
    available_cents: number;
  };
  accounts: Array<Record<string, unknown>>;
  usage: Awaited<ReturnType<typeof getUsageStats>>;
  active_tasks: number;
} | null> {
  const user = await getUserById(userId);
  if (!user) {
    return null;
  }

  const { password_hash: _passwordHash, ...safe } = user;
  const [accounts, usage, activeTasks, monthlyBilling, wallet] =
    await Promise.all([
      getAccountsByUserId(userId),
      getUsageStats(userId),
      getActiveTaskCountForUser(userId),
      getMonthlyMeteredBillingSummary(userId),
      getWalletBalanceSummary(userId),
    ]);

  return {
    user: {
      ...safe,
      account_count: accounts.length,
      active_tasks: activeTasks,
      usage,
      monthly_tokens_used: monthlyBilling.usedTokens,
      estimated_monthly_total_cents: monthlyBilling.chargedCents,
      purchased_cents: wallet.purchasedCents,
      bonus_cents: wallet.bonusCents,
      earned_cents: wallet.earnedCents,
      reserved_cents: wallet.reservedCents,
      available_cents: wallet.availableCents,
    },
    accounts: accounts.map(({ bot_token: _botToken, ...rest }) => rest),
    usage,
    active_tasks: activeTasks,
  };
}

/**
 * 管理端提现列表统一做身份证脱敏。
 */
export async function listAdminWithdrawalsMasked(input: {
  status?: 'pending' | 'approved' | 'rejected' | 'paid' | 'cancelled';
  creatorId?: string;
  limit?: number;
}) {
  const rows = await listAllWithdrawals({
    status: input.status,
    creatorId: input.creatorId,
    limit: input.limit,
  });

  return rows.map((row) => ({
    id: row.id,
    creator_id: row.creator_id,
    amount_cents: row.amount_cents,
    amount_yuan: row.amount_yuan,
    status: row.status,
    bank_name: row.bank_name,
    bank_account: row.bank_account,
    account_name: row.account_name,
    id_number_masked: row.id_number
      ? (() => {
          try {
            return maskIdNumber(decryptSensitive(row.id_number));
          } catch {
            return '解密失败';
          }
        })()
      : null,
    tax_type: row.tax_type,
    company_name: row.company_name,
    tax_id: row.tax_id,
    platform_fee_cents: row.platform_fee_cents,
    tax_amount_yuan: row.tax_amount_yuan,
    net_amount_yuan: row.net_amount_yuan,
    reviewed_by: row.reviewed_by,
    reviewed_at: row.reviewed_at,
    review_note: row.review_note,
    paid_at: row.paid_at,
    payment_proof: row.payment_proof,
    created_at: row.created_at,
  }));
}

/**
 * 管理端按申请单独查看身份证明文。
 */
export async function getAdminWithdrawalIdNumber(
  withdrawalId: string,
): Promise<{ id_number: string | null } | null> {
  const rows = await listAllWithdrawals({ limit: 1_000 });
  const withdrawal = rows.find((row) => row.id === withdrawalId);
  if (!withdrawal) {
    return null;
  }
  if (!withdrawal.id_number) {
    return { id_number: null };
  }
  return { id_number: decryptSensitive(withdrawal.id_number) };
}

/**
 * 聚合系统排盘全局状态列表。
 */
export async function listAdminGlobalSkills() {
  const [configs, catalog] = await Promise.all([
    getAllSkillGlobalConfigs(),
    Promise.resolve(listPaipanRegistry()),
  ]);
  const configMap = new Map(
    configs.map((config) => [config.skill_name, config]),
  );

  return catalog.map((skill) => {
    const config = configMap.get(skill.name);
    return {
      skill_name: skill.name,
      globally_enabled: config?.globally_enabled ?? false,
      dir: skill.dir,
    };
  });
}

/**
 * 判断系统排盘是否存在。
 */
export function hasOfficialSkill(name: string): boolean {
  return listPaipanRegistry().some((skill) => skill.name === name);
}
