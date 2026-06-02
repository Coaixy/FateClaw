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
  createPublicFinancialLedgerEntry,
  createUser,
  deletePublicFinancialLedgerEntry,
  deleteConversationLogsByAccountIds,
  deleteUser,
  getAccountsByUserId,
  getActiveTaskCountForUser,
  getAdminGlobalStats,
  getAllSkillGlobalConfigs,
  getAllUsers,
  getChatSessionPiCleanupCandidates,
  getChatSessionsForAdmin,
  getConversationLogById,
  getConversationLogByRequestId,
  getConversationLogSummaries,
  getCustomSkillForAdmin,
  getCustomSkillsForAdmin,
  getMessagesForAdmin,
  getMembershipConfig,
  getBalanceGrantsByUserId,
  getDailySignInConfig,
  getPiSessionCleanupCursor,
  getTasksForAdmin,
  getUserById,
  getUserByPhone,
  getUserCustomSkillById,
  getWalletTransactionsByUserId,
  grantBonusBalance,
  listBillingRequestReservations,
  listPublicFinancialLedgerEntries,
  markChatSessionPiSessionArchived,
  reconcileStaleBillingReservations,
  resetPiSessionCleanupCursor,
  setSkillGlobalEnabled,
  setUserCustomSkillAdminState,
  upsertPiSessionCleanupCursor,
  updateDailySignInConfig,
  updateMembershipConfig,
  updatePublicFinancialLedgerEntry,
} from '../../infrastructure/db.js';
import { getUsageStats } from '../../infrastructure/daily-usage.js';
import {
  createOfficialModel,
  getSystemConfigOverview,
  removeOfficialModel,
  updateModelBillingSettings,
  updateRuntimeSettings,
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
  deletePiSessionFilesForSession,
  readPiSessionArchiveForSession,
} from '../chat/pi-session-files.js';
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
  createPublicFinancialLedgerEntry,
  deleteConversationLogsByAccountIds,
  deletePublicFinancialLedgerEntry,
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
  listPublicFinancialLedgerEntries,
  reconcileStaleBillingReservations,
  removeOfficialModel,
  setSkillGlobalEnabled,
  setUserCustomSkillAdminState,
  updateModelBillingSettings,
  updateRuntimeSettings,
  updateOfficialModel,
  updateAdminRechargePaymentConfig,
  updatePublicFinancialLedgerEntry,
};

/** 管理后台软妹币奖励配置视图。 */
export interface AdminRewardConfigView {
  daily_sign_in: {
    enabled: boolean;
    reward_coins: number;
    updated_at: string;
  };
  membership: {
    enabled: boolean;
    monthly_price_coins: number;
    monthly_allowance_units: number;
    standard_price_per_million_units_coins: number;
    updated_at: string;
  };
}

/**
 * 读取后台软妹币奖励配置。
 */
export async function getAdminRewardConfig(): Promise<AdminRewardConfigView> {
  const [dailySignIn, membership] = await Promise.all([
    getDailySignInConfig(),
    getMembershipConfig(),
  ]);
  return {
    daily_sign_in: {
      enabled: dailySignIn.enabled,
      reward_coins: dailySignIn.reward_coins,
      updated_at: dailySignIn.updated_at,
    },
    membership: {
      enabled: membership.enabled,
      monthly_price_coins: membership.monthly_price_coins,
      monthly_allowance_units: membership.monthly_allowance_units,
      standard_price_per_million_units_coins:
        membership.standard_price_per_million_units_coins,
      updated_at: membership.updated_at,
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
  membership: {
    enabled: boolean;
    monthlyPriceCoins: number;
    monthlyAllowanceUnits: number;
    standardPricePerMillionUnitsCoins: number;
  };
}): Promise<AdminRewardConfigView> {
  const [dailySignIn, membership] = await Promise.all([
    updateDailySignInConfig({
      enabled: input.dailySignIn.enabled,
      rewardCoins: input.dailySignIn.rewardCoins,
    }),
    updateMembershipConfig({
      enabled: input.membership.enabled,
      monthlyPriceCoins: input.membership.monthlyPriceCoins,
      monthlyAllowanceUnits: input.membership.monthlyAllowanceUnits,
      standardPricePerMillionUnitsCoins:
        input.membership.standardPricePerMillionUnitsCoins,
    }),
  ]);
  return {
    daily_sign_in: {
      enabled: dailySignIn.enabled,
      reward_coins: dailySignIn.reward_coins,
      updated_at: dailySignIn.updated_at,
    },
    membership: {
      enabled: membership.enabled,
      monthly_price_coins: membership.monthly_price_coins,
      monthly_allowance_units: membership.monthly_allowance_units,
      standard_price_per_million_units_coins:
        membership.standard_price_per_million_units_coins,
      updated_at: membership.updated_at,
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

/** 管理后台 Pi session 文件清理结果。 */
export interface AdminPiSessionCleanupResult {
  success: true;
  mode: 'soft_deleted' | 'inactive';
  inactive_days: number | null;
  cutoff_at: string | null;
  cursor_before: string | null;
  cursor_after: string | null;
  cursor_reset: boolean;
  scanned_sessions: number;
  archived_sessions: number;
  touched_sessions: number;
  deleted_jsonl_files: number;
  deleted_path_files: number;
  missing_jsonl_files: number;
  skipped_unsafe_files: string[];
}

/**
 * 清理站内 AI Chat 的 Pi session 本地文件。
 *
 * @param input - 清理模式和管理员填写的未活跃天数。
 * @returns 清理统计，供后台确认实际影响范围。
 */
export async function cleanupPiSessionFilesForAdmin(input: {
  mode: 'soft_deleted' | 'inactive';
  inactiveDays?: number;
  limit?: number;
}): Promise<AdminPiSessionCleanupResult> {
  const cutoffAt =
    input.mode === 'inactive' && input.inactiveDays
      ? new Date(Date.now() - input.inactiveDays * 86_400_000).toISOString()
      : null;
  const cursor = await getPiSessionCleanupCursor(input.mode);
  const cursorBefore = cursor?.cursor_session_id ?? null;
  let candidates = await getChatSessionPiCleanupCandidates({
    softDeleted: input.mode === 'soft_deleted',
    inactiveBefore: cutoffAt ?? undefined,
    limit: input.limit,
    cursor: cursorBefore ?? undefined,
  });
  let cursorReset = false;

  if (candidates.length === 0 && cursorBefore) {
    await resetPiSessionCleanupCursor(input.mode);
    cursorReset = true;
    candidates = await getChatSessionPiCleanupCandidates({
      softDeleted: input.mode === 'soft_deleted',
      inactiveBefore: cutoffAt ?? undefined,
      limit: input.limit,
    });
  }

  let archivedSessions = 0;
  let touchedSessions = 0;
  let deletedJsonlFiles = 0;
  let deletedPathFiles = 0;
  let missingJsonlFiles = 0;
  const skippedUnsafeFiles: string[] = [];

  for (const candidate of candidates) {
    const archive = await readPiSessionArchiveForSession(candidate.id);
    const archived = await markChatSessionPiSessionArchived({
      sessionId: candidate.id,
      reason: input.mode,
      payload: archive.payload,
    });
    if (!archived) {
      continue;
    }
    archivedSessions += 1;
    missingJsonlFiles += archive.missingSessionFile ? 1 : 0;
    skippedUnsafeFiles.push(...archive.skippedUnsafeSessionFiles);

    const result = await deletePiSessionFilesForSession(candidate.id);
    if (
      result.deletedMappingFile ||
      result.deletedSessionFiles > 0 ||
      result.missingSessionFile ||
      result.skippedUnsafeSessionFiles.length > 0
    ) {
      touchedSessions += 1;
    }
    deletedJsonlFiles += result.deletedSessionFiles;
    deletedPathFiles += result.deletedMappingFile ? 1 : 0;
    skippedUnsafeFiles.push(...result.skippedUnsafeSessionFiles);
  }

  const cursorAfter = candidates.at(-1)?.id ?? null;
  if (cursorAfter) {
    await upsertPiSessionCleanupCursor({
      mode: input.mode,
      cursorSessionId: cursorAfter,
      scannedSessions: candidates.length,
    });
  }

  return {
    success: true,
    mode: input.mode,
    inactive_days:
      input.mode === 'inactive' ? (input.inactiveDays ?? null) : null,
    cutoff_at: cutoffAt,
    cursor_before: cursorReset ? null : cursorBefore,
    cursor_after: cursorAfter,
    cursor_reset: cursorReset,
    scanned_sessions: candidates.length,
    archived_sessions: archivedSessions,
    touched_sessions: touchedSessions,
    deleted_jsonl_files: deletedJsonlFiles,
    deleted_path_files: deletedPathFiles,
    missing_jsonl_files: missingJsonlFiles,
    skipped_unsafe_files: skippedUnsafeFiles,
  };
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
