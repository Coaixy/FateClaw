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
  createUser,
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
  getDailySignInConfig,
  getTasksForAdmin,
  getUserById,
  getUserByPhone,
  getUserCustomSkillById,
  getWalletTransactionsByUserId,
  grantBonusBalance,
  listBillingRequestReservations,
  reconcileStaleBillingReservations,
  setSkillGlobalEnabled,
  setUserCustomSkillAdminState,
  updateDailySignInConfig,
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
  reconcileStaleBillingReservations,
  removeOfficialModel,
  setOfficialModelSecret,
  setSkillGlobalEnabled,
  setUserCustomSkillAdminState,
  updateOfficialModel,
  updateAdminRechargePaymentConfig,
};

/** 管理后台软妹币奖励配置视图。 */
export interface AdminRewardConfigView {
  daily_sign_in: {
    enabled: boolean;
    reward_coins: number;
    updated_at: string;
  };
}

/**
 * 读取后台软妹币奖励配置。
 */
export async function getAdminRewardConfig(): Promise<AdminRewardConfigView> {
  const dailySignIn = await getDailySignInConfig();
  return {
    daily_sign_in: {
      enabled: dailySignIn.enabled,
      reward_coins: dailySignIn.reward_coins,
      updated_at: dailySignIn.updated_at,
    },
  };
}

/**
 * 更新后台软妹币奖励配置。
 */
export async function updateAdminRewardConfig(input: {
  dailySignIn: {
    enabled: boolean;
    rewardCoins: number;
  };
}): Promise<AdminRewardConfigView> {
  const dailySignIn = await updateDailySignInConfig({
    enabled: input.dailySignIn.enabled,
    rewardCoins: input.dailySignIn.rewardCoins,
  });
  return {
    daily_sign_in: {
      enabled: dailySignIn.enabled,
      reward_coins: dailySignIn.reward_coins,
      updated_at: dailySignIn.updated_at,
    },
  };
}

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
    purchased_coins: 0,
    bonus_coins: 0,
    reserved_coins: 0,
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
      estimated_monthly_total_coins: number;
      purchased_coins: number;
      bonus_coins: number;
      reserved_coins: number;
      available_coins: number;
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
        estimated_monthly_total_coins: monthlyBilling.chargedCoins,
        purchased_coins: wallet.purchasedCoins,
        bonus_coins: wallet.bonusCoins,
        reserved_coins: wallet.reservedCoins,
        available_coins: wallet.availableCoins,
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
    estimated_monthly_total_coins: number;
    purchased_coins: number;
    bonus_coins: number;
    reserved_coins: number;
    available_coins: number;
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
      estimated_monthly_total_coins: monthlyBilling.chargedCoins,
      purchased_coins: wallet.purchasedCoins,
      bonus_coins: wallet.bonusCoins,
      reserved_coins: wallet.reservedCoins,
      available_coins: wallet.availableCoins,
    },
    accounts: accounts.map(({ bot_token: _botToken, ...rest }) => rest),
    usage,
    active_tasks: activeTasks,
  };
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
