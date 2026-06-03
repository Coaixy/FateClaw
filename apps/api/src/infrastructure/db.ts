import pg from 'pg';

import { DATABASE_URL } from './config.js';
import {
  closeDbPool,
  getDbPool as getSharedDbPool,
  initDbPool,
} from './db-pool.js';
import { runDatabaseMigrations } from './migrations.js';
import {
  bindAccountToUser,
  createAccount,
  deleteAccount,
  getAccount,
  getAccountsByUserId,
  getAllAccounts,
  getEnabledAccounts,
  getSoulContent,
  updateAccount,
  updateSoulContent,
} from './repositories/accounts-repository.js';
import {
  getAdminGlobalStats,
  getChatSessionPiCleanupCandidates,
  getChatSessionsForAdmin,
  getCustomSkillForAdmin,
  getCustomSkillsForAdmin,
  getMessagesForAdmin,
  getPiSessionCleanupCursor,
  getTasksForAdmin,
  resetPiSessionCleanupCursor,
  upsertPiSessionCleanupCursor,
} from './repositories/admin-repository.js';
import type {
  AdminChatSessionRow,
  AdminCustomSkillRow,
  AdminGlobalStats,
  AdminMessageRow,
  AdminPiSessionCleanupCursorRow,
  AdminRechargePeriodStats,
  AdminRechargeStatsRange,
  AdminTaskRow,
} from './repositories/admin-repository.js';
import {
  adjustUserPurchasedBalance,
  createDailySignInReward,
  expireBonusBalance,
  getBillingRequestReservationByRequestId,
  getDailySignInConfig,
  getDailySignInRecordByDate,
  getMembershipConfig,
  getMonthlyModelChargeCoins,
  getMembershipOverview,
  getBalanceGrantsByUserId,
  getRechargeOrderByTradeId,
  getRechargeOrderByTradeIdForUser,
  getRechargePaymentConfig,
  getRechargeStatsByUserId,
  getVisibleWalletTransactionsByUserId,
  getWalletTransactionsByUserId,
  grantBonusBalance,
  insertRechargeOrder,
  listBillingRequestReservations,
  listRechargeOrdersByUserId,
  markRechargeOrderFailed,
  markRechargeOrderPaymentCreated,
  reconcileStaleBillingReservations,
  releaseUserBalanceReservation,
  reserveUserBalanceCoins,
  settleRechargeOrderPaid,
  settleUserModelChargeCoins,
  subscribeMembershipWithWallet,
  updateDailySignInConfig,
  updateMembershipConfig,
  updateRechargePaymentConfig,
} from './repositories/billing-repository.js';
import type {
  BillingRequestReservationRow,
  DeductBalanceResult,
  DailySignInConfigRow,
  DailySignInRecordRow,
  MonthlyBillingStateRow,
  MembershipAllowanceRow,
  MembershipConfigRow,
  MembershipOverviewRow,
  BalanceGrantRow,
  RechargeOrderRow,
  RechargeOrderStatus,
  RechargePayType,
  RechargePaymentConfigRow,
  RechargeStatsRow,
  WalletTransactionRow,
  UserMembershipRow,
} from './repositories/billing-repository.js';
import {
  createChatSession,
  deleteChatSession,
  getChatSession,
  getChatSessionPiSessionArchive,
  getChatSessions,
  getChatSessionsByUserId,
  getSharedChatSessionByToken,
  getMessagesSince,
  getRecentMessages,
  hasFinalAiChatSessionReply,
  getSessionMessages,
  getSessionMessagesWithToolContext,
  getSessionMessageById,
  markChatSessionPiSessionArchived,
  markChatSessionPiSessionArchiveRestored,
  resetUserMessages,
  shareOwnedChatSession,
  storeMessage,
  touchChatSession,
  updateChatSessionTitle,
} from './repositories/chat-repository.js';
import type { ChatSessionPiSessionArchiveRow } from './repositories/chat-repository.js';
import {
  deleteWechatChatSessionLink,
  getWechatChatSessionLink,
  touchWechatChatSessionLink,
  upsertWechatChatSessionLink,
} from './repositories/wechat-session-link-repository.js';
import {
  createConfigAuditLog,
  createOfficialModelConfig,
  deleteOfficialModelConfig,
  deleteUserModelSelectionsByOfficialModelId,
  getOfficialModelConfig,
  getModelBillingConfig,
  getRuntimeConfig,
  getSystemSecret,
  getUserModelConfig,
  getUserModelSelection,
  listConfigAuditLogs,
  listOfficialModelConfigs,
  updateOfficialModelConfig,
  updateModelBillingConfig,
  updateRuntimeConfig,
  upsertSystemSecret,
  upsertUserModelConfig,
  upsertUserModelSelection,
} from './repositories/config-repository.js';
import {
  deleteConversationLogsByAccountIds,
  getConversationLogById,
  getConversationLogByRequestId,
  getConversationLogSummaries,
  getConversationLogs,
  getConversationLogsByTimeWindow,
  purgeExpiredTraceEvents,
  storeConversationLog,
} from './repositories/conversation-log-repository.js';
import type {
  ConversationLogRow,
  ConversationLogSummaryRow,
} from './repositories/conversation-log-repository.js';
import {
  createPublicFinancialLedgerEntry,
  deletePublicFinancialLedgerEntry,
  listPublicFinancialLedgerEntries,
  updatePublicFinancialLedgerEntry,
} from './repositories/public-financial-ledger-repository.js';
import type {
  PublicFinancialLedgerEntryInput,
  PublicFinancialLedgerEntryRow,
  PublicFinancialLedgerEntryType,
} from './repositories/public-financial-ledger-repository.js';
import {
  createUser,
  getAllUsers,
  getUserByAccountId,
  getUserById,
  getUserByPhone,
  getUserByPhoneUsing,
  getUserSoulEditEnabled,
  getUserSoulContent,
  promoteUserToCreator,
  updateUserSoulEditEnabled,
  updateUserPasswordHash,
  updateUserRole,
  updateUserSoulContent,
} from './repositories/users-repository.js';
import {
  claimDueTasks,
  createTask,
  deleteTask,
  extendTaskRunLock,
  getActiveTaskCountForUser,
  getAllTasks,
  getTaskById,
  getTasksForAccount,
  logTaskRun,
  resetUserTasks,
  updateTask,
  updateTaskAfterRun,
} from './repositories/tasks-repository.js';
import {
  createSkillBundle,
  createUserCustomSkill,
  deleteSkillBundle,
  deleteUserCustomSkill,
  getAllSkillGlobalConfigs,
  getBundleByToken,
  getEffectiveUserSkills,
  getGloballyEnabledSkillNames,
  getResolvedEnabledOfficialSkillNames,
  getSkillByShareToken,
  getSubscribedSkills,
  getSubscriberIds,
  getUserCustomSkill,
  getUserCustomSkillById,
  getUserCustomSkillCount,
  getUserCustomSkills,
  listMarketBundles,
  listMarketSkills,
  listUserBundles,
  publishSkillBundle,
  publishUserCustomSkill,
  seedOfficialSkills,
  setUserCustomSkillAdminState,
  setSkillGlobalEnabled,
  shareSkillBundle,
  shareUserCustomSkill,
  subscribeToBundle,
  subscribeToSkill,
  toggleSubscription,
  toggleUserCustomSkill,
  unpublishSkillBundle,
  unpublishUserCustomSkill,
  unsubscribeFromBundle,
  unsubscribeFromSkill,
  unshareSkillBundle,
  unshareUserCustomSkill,
  updateSkillBundle,
  updateUserCustomSkill,
} from './repositories/skills-repository.js';
import type {
  BundleByTokenResult,
  MarketBundleListRow,
  MarketSkillListRow,
  SkillGlobalConfig,
  SubscribeToBundleResult,
} from './repositories/skills-repository.js';

export {
  adjustUserPurchasedBalance,
  bindAccountToUser,
  claimDueTasks,
  createAccount,
  createChatSession,
  createConfigAuditLog,
  createDailySignInReward,
  createOfficialModelConfig,
  createPublicFinancialLedgerEntry,
  createSkillBundle,
  createTask,
  createUser,
  createUserCustomSkill,
  deleteAccount,
  deleteChatSession,
  deleteConversationLogsByAccountIds,
  deleteOfficialModelConfig,
  deletePublicFinancialLedgerEntry,
  deleteSkillBundle,
  deleteTask,
  deleteUserCustomSkill,
  deleteUserModelSelectionsByOfficialModelId,
  deleteWechatChatSessionLink,
  expireBonusBalance,
  extendTaskRunLock,
  getAccount,
  getAccountsByUserId,
  getActiveTaskCountForUser,
  getAdminGlobalStats,
  getAllSkillGlobalConfigs,
  getAllTasks,
  getAllUsers,
  getAllAccounts,
  getBillingRequestReservationByRequestId,
  getBundleByToken,
  getChatSession,
  getChatSessionPiSessionArchive,
  getChatSessionPiCleanupCandidates,
  getChatSessions,
  getChatSessionsByUserId,
  getChatSessionsForAdmin,
  getConversationLogById,
  getConversationLogByRequestId,
  getConversationLogSummaries,
  getConversationLogs,
  getConversationLogsByTimeWindow,
  getCustomSkillForAdmin,
  getCustomSkillsForAdmin,
  getDailySignInConfig,
  getDailySignInRecordByDate,
  getEffectiveUserSkills,
  getEnabledAccounts,
  getGloballyEnabledSkillNames,
  getMembershipConfig,
  getMembershipOverview,
  getMonthlyModelChargeCoins,
  getMessagesForAdmin,
  getModelBillingConfig,
  getMessagesSince,
  getOfficialModelConfig,
  getPiSessionCleanupCursor,
  getBalanceGrantsByUserId,
  getRechargeOrderByTradeId,
  getRechargeOrderByTradeIdForUser,
  getRechargePaymentConfig,
  getRechargeStatsByUserId,
  getRecentMessages,
  getResolvedEnabledOfficialSkillNames,
  getRuntimeConfig,
  getSessionMessageById,
  getSessionMessages,
  getSessionMessagesWithToolContext,
  getSharedChatSessionByToken,
  hasFinalAiChatSessionReply,
  getSkillByShareToken,
  getSoulContent,
  getSubscribedSkills,
  getSubscriberIds,
  getSystemSecret,
  getTasksForAdmin,
  getTaskById,
  getTasksForAccount,
  getUserByAccountId,
  getUserById,
  getUserByPhone,
  getUserSoulEditEnabled,
  getUserSoulContent,
  getUserCustomSkill,
  getUserCustomSkillById,
  getUserCustomSkillCount,
  getUserCustomSkills,
  getUserModelConfig,
  getUserModelSelection,
  getWechatChatSessionLink,
  getVisibleWalletTransactionsByUserId,
  getWalletTransactionsByUserId,
  grantBonusBalance,
  insertRechargeOrder,
  listBillingRequestReservations,
  listConfigAuditLogs,
  listMarketBundles,
  listMarketSkills,
  listOfficialModelConfigs,
  listPublicFinancialLedgerEntries,
  listRechargeOrdersByUserId,
  listUserBundles,
  logTaskRun,
  markChatSessionPiSessionArchived,
  markChatSessionPiSessionArchiveRestored,
  markRechargeOrderFailed,
  markRechargeOrderPaymentCreated,
  promoteUserToCreator,
  publishSkillBundle,
  publishUserCustomSkill,
  purgeExpiredTraceEvents,
  reconcileStaleBillingReservations,
  releaseUserBalanceReservation,
  resetPiSessionCleanupCursor,
  resetUserMessages,
  resetUserTasks,
  reserveUserBalanceCoins,
  seedOfficialSkills,
  setSkillGlobalEnabled,
  setUserCustomSkillAdminState,
  shareOwnedChatSession,
  shareSkillBundle,
  shareUserCustomSkill,
  settleRechargeOrderPaid,
  settleUserModelChargeCoins,
  subscribeMembershipWithWallet,
  subscribeToBundle,
  subscribeToSkill,
  storeMessage,
  storeConversationLog,
  touchChatSession,
  touchWechatChatSessionLink,
  toggleSubscription,
  toggleUserCustomSkill,
  updateDailySignInConfig,
  updateMembershipConfig,
  updateModelBillingConfig,
  updateAccount,
  updateChatSessionTitle,
  updateOfficialModelConfig,
  updatePublicFinancialLedgerEntry,
  updateRuntimeConfig,
  updateSoulContent,
  updateTask,
  updateTaskAfterRun,
  updateRechargePaymentConfig,
  updateSkillBundle,
  updateUserCustomSkill,
  updateUserPasswordHash,
  updateUserRole,
  updateUserSoulEditEnabled,
  updateUserSoulContent,
  unpublishSkillBundle,
  unpublishUserCustomSkill,
  unsubscribeFromBundle,
  unsubscribeFromSkill,
  unshareSkillBundle,
  unshareUserCustomSkill,
  upsertPiSessionCleanupCursor,
  upsertSystemSecret,
  upsertUserModelConfig,
  upsertUserModelSelection,
  upsertWechatChatSessionLink,
};
export type {
  AdminChatSessionRow,
  AdminCustomSkillRow,
  AdminGlobalStats,
  AdminMessageRow,
  AdminPiSessionCleanupCursorRow,
  AdminRechargePeriodStats,
  AdminRechargeStatsRange,
  AdminTaskRow,
  BillingRequestReservationRow,
  BundleByTokenResult,
  ChatSessionPiSessionArchiveRow,
  ConversationLogRow,
  ConversationLogSummaryRow,
  DailySignInConfigRow,
  DailySignInRecordRow,
  DeductBalanceResult,
  MembershipAllowanceRow,
  MembershipConfigRow,
  MembershipOverviewRow,
  MarketBundleListRow,
  MarketSkillListRow,
  MonthlyBillingStateRow,
  PublicFinancialLedgerEntryInput,
  PublicFinancialLedgerEntryRow,
  PublicFinancialLedgerEntryType,
  BalanceGrantRow,
  RechargeOrderRow,
  RechargeOrderStatus,
  RechargePayType,
  RechargePaymentConfigRow,
  RechargeStatsRow,
  SkillGlobalConfig,
  SubscribeToBundleResult,
  UserMembershipRow,
  WalletTransactionRow,
};
import { deleteUsersWithoutValidPhone } from './phone-only-user-migration.js';

let pool: pg.Pool;

export function getDbPool(): pg.Pool {
  return getSharedDbPool();
}

export async function initDatabase(): Promise<void> {
  if (!DATABASE_URL) {
    throw new Error('缺少 DATABASE_URL 环境变量');
  }

  pool = initDbPool(DATABASE_URL);

  // 验证连接
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
    await runDatabaseMigrations(client);
    await deleteUsersWithoutValidPhone(client);
  } finally {
    client.release();
  }
}

/** @internal - for tests only. */
export async function _initTestDatabase(): Promise<void> {
  // Tests should use a real PG database or a mock
  await initDatabase();
}

export async function closeDatabase(): Promise<void> {
  await closeDbPool();
}

/**
 * 验证 Postgres 连接可用。readiness probe 用，超时由调用方控制。
 */
export async function pingDatabase(): Promise<void> {
  await pool.query('SELECT 1');
}

export async function deleteUser(userId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 删除用户作为订阅者 / 创作者 / 拥有者的全部关系数据
    await client.query(
      `DELETE FROM user_skill_subscriptions
       WHERE subscriber_id = $1
          OR skill_id IN (SELECT id FROM user_custom_skills WHERE user_id = $1)`,
      [userId],
    );
    await client.query('DELETE FROM skill_bundles WHERE user_id = $1', [
      userId,
    ]);
    await client.query(
      'DELETE FROM billing_request_reservations WHERE user_id = $1',
      [userId],
    );
    await client.query('DELETE FROM monthly_billing_state WHERE user_id = $1', [
      userId,
    ]);
    await client.query('DELETE FROM membership_allowances WHERE user_id = $1', [
      userId,
    ]);
    await client.query('DELETE FROM user_memberships WHERE user_id = $1', [
      userId,
    ]);
    await client.query('DELETE FROM wallet_transactions WHERE user_id = $1', [
      userId,
    ]);
    await client.query('DELETE FROM balance_grants WHERE user_id = $1', [
      userId,
    ]);
    await client.query('DELETE FROM user_custom_skills WHERE user_id = $1', [
      userId,
    ]);

    // 删除用户拥有的账号链路
    await client.query(
      `DELETE FROM task_run_logs WHERE task_id IN
       (SELECT t.id FROM scheduled_tasks t JOIN accounts a ON a.id = t.account_id WHERE a.owner_id = $1)`,
      [userId],
    );
    await client.query(
      `DELETE FROM scheduled_tasks WHERE account_id IN
       (SELECT id FROM accounts WHERE owner_id = $1)`,
      [userId],
    );
    await client.query(
      `DELETE FROM conversation_logs WHERE account_id IN
       (SELECT id FROM accounts WHERE owner_id = $1)`,
      [userId],
    );
    await client.query(
      `DELETE FROM messages WHERE account_id IN
       (SELECT id FROM accounts WHERE owner_id = $1)`,
      [userId],
    );
    await client.query(
      `DELETE FROM chat_sessions WHERE account_id IN
       (SELECT id FROM accounts WHERE owner_id = $1)`,
      [userId],
    );
    await client.query('DELETE FROM daily_usage WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM accounts WHERE owner_id = $1', [userId]);
    await client.query('DELETE FROM users WHERE id = $1', [userId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 重置用户的所有数据：消息、定时任务（含运行日志）。
 * 使用软删除（标记 deleted_at）而非物理删除，以满足审查要求。
 */
export async function resetUserData(userId: string): Promise<string[]> {
  const now = new Date().toISOString();
  const userAccounts = await getAccountsByUserId(userId);
  const accountIds = userAccounts.map((a) => a.id);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const accountId of accountIds) {
      await client.query(
        `UPDATE task_run_logs SET deleted_at = $1 WHERE deleted_at IS NULL AND task_id IN
         (SELECT id FROM scheduled_tasks WHERE account_id = $2)`,
        [now, accountId],
      );
      await client.query(
        'UPDATE scheduled_tasks SET deleted_at = $1 WHERE account_id = $2 AND deleted_at IS NULL',
        [now, accountId],
      );
      await client.query(
        'UPDATE messages SET deleted_at = $1 WHERE account_id = $2 AND deleted_at IS NULL',
        [now, accountId],
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return accountIds;
}

// EOF — Persona 相关代码已删除
