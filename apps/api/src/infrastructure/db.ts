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
  getChatSessionPiArchiveStates,
  getChatSessionPiCleanupCandidates,
  getChatSessionsForAdmin,
  getCustomSkillForAdmin,
  getCustomSkillsForAdmin,
  getMessagesForAdmin,
  getPiSessionCleanupCursor,
  resetPiSessionCleanupCursor,
  upsertPiSessionCleanupCursor,
} from './repositories/admin-repository.js';
import type {
  AdminChatSessionRow,
  AdminChatSessionPiArchiveState,
  AdminCustomSkillRow,
  AdminGlobalStats,
  AdminMessageRow,
  AdminPiSessionCleanupCursorRow,
  AdminRechargePeriodStats,
  AdminRechargeStatsRange,
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
  archiveChatSession,
  createChatSession,
  deleteChatSession,
  getArchivedChatSessionsByUserId,
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
  restoreArchivedChatSession,
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
  createSkillBundle,
  createSkillAccessInvite,
  createUserCustomSkill,
  deleteSkillBundle,
  deleteUserCustomSkill,
  getAllSkillGlobalConfigs,
  getBundleByToken,
  getEffectiveUserSkills,
  getGloballyEnabledSkillNames,
  getResolvedEnabledOfficialSkillNames,
  getSkillAccessInvitePreviewByToken,
  getSkillByShareToken,
  getSubscribedSkills,
  getSubscriberIds,
  getUserCustomSkill,
  getUserCustomSkillById,
  getUserCustomSkillCount,
  getUserCustomSkills,
  listMarketBundles,
  listMarketSkills,
  listSkillAccessInvites,
  listUserBundles,
  publishSkillBundle,
  publishUserCustomSkill,
  redeemSkillAccessInvite,
  resolveSkillAccessInviteStatus,
  revokeSkillAccessInvite,
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
  RedeemSkillAccessInviteResult,
  SkillAccessInvitePreviewResult,
  SkillAccessInviteStatus,
  SkillGlobalConfig,
  SubscribeToBundleResult,
} from './repositories/skills-repository.js';

export {
  adjustUserPurchasedBalance,
  archiveChatSession,
  bindAccountToUser,
  createAccount,
  createChatSession,
  createConfigAuditLog,
  createDailySignInReward,
  createOfficialModelConfig,
  createPublicFinancialLedgerEntry,
  createSkillBundle,
  createSkillAccessInvite,
  createUser,
  createUserCustomSkill,
  deleteAccount,
  deleteChatSession,
  deleteConversationLogsByAccountIds,
  deleteOfficialModelConfig,
  deletePublicFinancialLedgerEntry,
  deleteSkillBundle,
  deleteUserCustomSkill,
  deleteUserModelSelectionsByOfficialModelId,
  deleteWechatChatSessionLink,
  expireBonusBalance,
  getAccount,
  getAccountsByUserId,
  getAdminGlobalStats,
  getAllSkillGlobalConfigs,
  getAllUsers,
  getAllAccounts,
  getArchivedChatSessionsByUserId,
  getBillingRequestReservationByRequestId,
  getBundleByToken,
  getChatSession,
  getChatSessionPiSessionArchive,
  getChatSessionPiArchiveStates,
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
  getSkillAccessInvitePreviewByToken,
  getSkillByShareToken,
  getSoulContent,
  getSubscribedSkills,
  getSubscriberIds,
  getSystemSecret,
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
  listSkillAccessInvites,
  listUserBundles,
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
  redeemSkillAccessInvite,
  resolveSkillAccessInviteStatus,
  resetPiSessionCleanupCursor,
  resetUserMessages,
  restoreArchivedChatSession,
  revokeSkillAccessInvite,
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
  SkillAccessInvitePreviewResult,
  SkillAccessInviteStatus,
  RedeemSkillAccessInviteResult,
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
 * 重置用户的所有消息数据。
 *
 * @param userId 需要重置数据的用户 ID。
 * @returns 被重置的账号 ID 列表。
 * @remarks 使用软删除（标记 deleted_at）而非物理删除，以满足审查要求。
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
