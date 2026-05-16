/**
 * 管理后台服务层。
 *
 * 对外暴露管理端需要的领域能力，避免 route 直接拼装
 * 数据库、系统配置与套餐模块的细节。
 */

import {
  adjustUserPurchasedPoints,
  approveWithdrawal,
  decryptSensitive,
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
  getPointBatchesByUserId,
  getSkillsForAdmin,
  getTasksForAdmin,
  getUserById,
  getUserCustomSkillById,
  getWalletTransactionsByUserId,
  grantBonusPoints,
  listAllWithdrawals,
  listBillingRequestReservations,
  markWithdrawalPaid,
  maskIdNumber,
  reconcileStaleBillingReservations,
  rejectWithdrawal,
  setSkillDefaultEnabled,
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
import { loadOfficialSkillCatalog } from '../skills/skill-manifest.js';

export {
  adjustUserPurchasedPoints,
  approveWithdrawal,
  createOfficialModel,
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
  getPointBatchesByUserId,
  getSkillsForAdmin,
  getSystemConfigOverview,
  getTasksForAdmin,
  getUserById,
  getUserCustomSkillById,
  getWalletTransactionsByUserId,
  grantBonusPoints,
  listBillingRequestReservations,
  markWithdrawalPaid,
  reconcileStaleBillingReservations,
  removeOfficialModel,
  rejectWithdrawal,
  setOfficialModelSecret,
  setSkillDefaultEnabled,
  setSkillGlobalEnabled,
  setUserCustomSkillAdminState,
  updateOfficialModel,
  updateAdminRechargePaymentConfig,
};

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
      estimated_monthly_total_points: number;
      purchased_points: number;
      bonus_points: number;
      earned_points: number;
      reserved_points: number;
      available_points: number;
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
        estimated_monthly_total_points: monthlyBilling.chargedPoints,
        purchased_points: wallet.purchasedPoints,
        bonus_points: wallet.bonusPoints,
        earned_points: wallet.earnedPoints,
        reserved_points: wallet.reservedPoints,
        available_points: wallet.availablePoints,
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
    estimated_monthly_total_points: number;
    purchased_points: number;
    bonus_points: number;
    earned_points: number;
    reserved_points: number;
    available_points: number;
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
      estimated_monthly_total_points: monthlyBilling.chargedPoints,
      purchased_points: wallet.purchasedPoints,
      bonus_points: wallet.bonusPoints,
      earned_points: wallet.earnedPoints,
      reserved_points: wallet.reservedPoints,
      available_points: wallet.availablePoints,
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
    amount_points: row.amount_points,
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
    platform_fee_points: row.platform_fee_points,
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
 * 聚合官方 Skill 全局状态列表。
 */
export async function listAdminGlobalSkills() {
  const [configs, catalog] = await Promise.all([
    getAllSkillGlobalConfigs(),
    Promise.resolve(loadOfficialSkillCatalog()),
  ]);
  const configMap = new Map(
    configs.map((config) => [config.skill_name, config]),
  );

  return catalog.map((skill) => {
    const config = configMap.get(skill.name);
    return {
      skill_name: skill.name,
      globally_enabled: config?.globally_enabled ?? false,
      default_enabled: config?.default_enabled ?? true,
      dir: skill.dir,
      description: skill.description,
      trigger: skill.trigger,
      manifestSource: skill.manifestSource,
      manifestVersion: skill.manifestVersion,
      requiresLoad: skill.requiresLoad,
      entry: skill.entry,
    };
  });
}

/**
 * 判断官方 Skill 是否存在。
 */
export function hasOfficialSkill(name: string): boolean {
  return loadOfficialSkillCatalog().some((skill) => skill.name === name);
}
