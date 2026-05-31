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
  getTasksForAdmin,
} from './repositories/admin-repository.js';
import type {
  AdminChatSessionRow,
  AdminCustomSkillRow,
  AdminGlobalStats,
  AdminMessageRow,
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
  getMonthlyModelChargeCoins,
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
  updateDailySignInConfig,
  updateRechargePaymentConfig,
} from './repositories/billing-repository.js';
import type {
  BillingRequestReservationRow,
  DeductBalanceResult,
  DailySignInConfigRow,
  DailySignInRecordRow,
  MonthlyBillingStateRow,
  BalanceGrantRow,
  RechargeOrderRow,
  RechargeOrderStatus,
  RechargePayType,
  RechargePaymentConfigRow,
  RechargeStatsRow,
  WalletTransactionRow,
} from './repositories/billing-repository.js';
import {
  createChatSession,
  deleteChatSession,
  getChatSession,
  getChatSessions,
  getChatSessionsByUserId,
  getMessagesSince,
  getRecentMessages,
  hasFinalAiChatSessionReply,
  getSessionMessagesWithToolContext,
  getSessionMessageById,
  resetUserMessages,
  storeMessage,
  touchChatSession,
  updateChatSessionTitle,
} from './repositories/chat-repository.js';
import {
  createConfigAuditLog,
  createOfficialModelConfig,
  deleteOfficialModelConfig,
  getOfficialModelConfig,
  getModelBillingConfig,
  getSystemSecret,
  getUserModelConfig,
  getUserModelSelection,
  listConfigAuditLogs,
  listOfficialModelConfigs,
  updateOfficialModelConfig,
  updateModelBillingConfig,
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
  getUserSoulContent,
  promoteUserToCreator,
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
  getCreatorBundleConfig,
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
  listCreatorSharedSkills,
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
  subscribeToCreatorBundle,
  subscribeToSkill,
  subscribeToSkillPaid,
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
  upsertCreatorBundleConfig,
} from './repositories/skills-repository.js';
import type {
  BundleByTokenResult,
  MarketBundleListRow,
  MarketSkillListRow,
  SkillGlobalConfig,
  SubscribeToBundleResult,
  SubscribeToCreatorBundleInput,
  SubscribeToSkillPaidInput,
  SubscribeToSkillPaidResult,
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
  getCreatorBundleConfig,
  getDailySignInConfig,
  getDailySignInRecordByDate,
  getEffectiveUserSkills,
  getEnabledAccounts,
  getGloballyEnabledSkillNames,
  getMonthlyModelChargeCoins,
  getMessagesForAdmin,
  getModelBillingConfig,
  getMessagesSince,
  getOfficialModelConfig,
  getBalanceGrantsByUserId,
  getRechargeOrderByTradeId,
  getRechargeOrderByTradeIdForUser,
  getRechargePaymentConfig,
  getRechargeStatsByUserId,
  getRecentMessages,
  getResolvedEnabledOfficialSkillNames,
  getSessionMessageById,
  getSessionMessagesWithToolContext,
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
  getUserSoulContent,
  getUserCustomSkill,
  getUserCustomSkillById,
  getUserCustomSkillCount,
  getUserCustomSkills,
  getUserModelConfig,
  getUserModelSelection,
  getVisibleWalletTransactionsByUserId,
  getWalletTransactionsByUserId,
  grantBonusBalance,
  insertRechargeOrder,
  listCreatorSharedSkills,
  listBillingRequestReservations,
  listConfigAuditLogs,
  listMarketBundles,
  listMarketSkills,
  listOfficialModelConfigs,
  listPublicFinancialLedgerEntries,
  listRechargeOrdersByUserId,
  listUserBundles,
  logTaskRun,
  markRechargeOrderFailed,
  markRechargeOrderPaymentCreated,
  promoteUserToCreator,
  publishSkillBundle,
  publishUserCustomSkill,
  purgeExpiredTraceEvents,
  reconcileStaleBillingReservations,
  releaseUserBalanceReservation,
  resetUserMessages,
  resetUserTasks,
  reserveUserBalanceCoins,
  seedOfficialSkills,
  setSkillGlobalEnabled,
  setUserCustomSkillAdminState,
  shareSkillBundle,
  shareUserCustomSkill,
  settleRechargeOrderPaid,
  settleUserModelChargeCoins,
  subscribeToBundle,
  subscribeToCreatorBundle,
  subscribeToSkill,
  subscribeToSkillPaid,
  storeMessage,
  storeConversationLog,
  touchChatSession,
  toggleSubscription,
  toggleUserCustomSkill,
  updateDailySignInConfig,
  updateModelBillingConfig,
  updateAccount,
  updateChatSessionTitle,
  updateOfficialModelConfig,
  updatePublicFinancialLedgerEntry,
  updateSoulContent,
  updateTask,
  updateTaskAfterRun,
  updateRechargePaymentConfig,
  updateSkillBundle,
  updateUserCustomSkill,
  updateUserPasswordHash,
  updateUserRole,
  updateUserSoulContent,
  unpublishSkillBundle,
  unpublishUserCustomSkill,
  unsubscribeFromBundle,
  unsubscribeFromSkill,
  unshareSkillBundle,
  unshareUserCustomSkill,
  upsertCreatorBundleConfig,
  upsertSystemSecret,
  upsertUserModelConfig,
  upsertUserModelSelection,
};
export type {
  AdminChatSessionRow,
  AdminCustomSkillRow,
  AdminGlobalStats,
  AdminMessageRow,
  AdminRechargePeriodStats,
  AdminRechargeStatsRange,
  AdminTaskRow,
  BillingRequestReservationRow,
  BundleByTokenResult,
  ConversationLogRow,
  ConversationLogSummaryRow,
  DailySignInConfigRow,
  DailySignInRecordRow,
  DeductBalanceResult,
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
  SubscribeToCreatorBundleInput,
  SubscribeToSkillPaidInput,
  SubscribeToSkillPaidResult,
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
      `DELETE FROM creator_bundle_subscriptions
       WHERE subscriber_id = $1 OR creator_id = $1`,
      [userId],
    );
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
      'DELETE FROM creator_bundle_config WHERE creator_id = $1',
      [userId],
    );
    await client.query(
      'DELETE FROM billing_request_reservations WHERE user_id = $1',
      [userId],
    );
    await client.query('DELETE FROM monthly_billing_state WHERE user_id = $1', [
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
