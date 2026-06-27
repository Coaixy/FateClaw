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
  getAccountCountsByOwnerIds,
  getAccountsByUserId,
  getAllAccounts,
  getEnabledAccounts,
  getSingleAccountIdIfOnlyOne,
  getSoulContent,
  updateAccount,
  updateSoulContent,
} from './repositories/accounts-repository.js';
import {
  countActiveUserApiKeys,
  createUserApiKey,
  findActiveApiKeyByHash,
  hashApiKey,
  listUserApiKeys,
  revokeUserApiKey,
  toApiKeyDto,
  touchApiKeyLastUsed,
} from './repositories/api-keys-repository.js';
import {
  createOpenSession,
  findOpenSessionByIdForUser,
  softDeleteOpenSession,
  toOpenSessionDto,
  touchOpenSessionActivity,
} from './repositories/open-sessions-repository.js';
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
import {
  createAnnouncement,
  deleteDraftAnnouncement,
  getActiveAnnouncement,
  getAdminAnnouncementById,
  getPublicAnnouncementBySlug,
  listAdminAnnouncements,
  listPublicAnnouncements,
  updateAnnouncement,
} from './repositories/announcements-repository.js';
import {
  adjustUserPurchasedBalance,
  cancelUserMembershipsForAdmin,
  expireUserBonusBalanceBefore,
  getBillingRequestReservationByRequestId,
  getMembershipEntitlements,
  getMembershipConfig,
  getMembershipPlanConfigs,
  getMonthlyModelChargeCoins,
  getMonthlyModelChargeCoinsByUserIds,
  getMembershipOverview,
  getMembershipOverviewsByUserIds,
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
  listBillingRequestReservationsPageForAdmin,
  listStalePendingReservations,
  listRechargeOrdersForAdmin,
  listRechargeOrdersByUserId,
  listWalletTransactionsForAdmin,
  markRechargeOrderFailed,
  markRechargeOrderPaymentCreated,
  reconcileStaleBillingReservations,
  reserveUserBalanceCoins,
  settleRechargeOrderPaid,
  settleUserModelChargeCoins,
  setUserMembershipForAdmin,
  subscribeMembershipWithWallet,
  updateMembershipConfig,
  updateRechargePaymentConfig,
} from './repositories/billing-repository.js';
import type {
  MembershipEntitlementRow,
  RechargeOrderRow,
  RechargePayType,
  RechargePaymentConfigRow,
  RechargeStatsRow,
} from './repositories/billing-repository.js';
import {
  archiveChatSession,
  createChatSession,
  getArchivedChatSessionsByUserId,
  getChatSession,
  getChatSessionByIdForAdmin,
  getChatSessionPiSessionArchive,
  getChatSessionsByClientId,
  getChatSessionsByUserId,
  getSharedChatSessionByToken,
  getRecentMessages,
  hasFinalAiChatSessionReply,
  getSessionMessages,
  getSessionMessagesForAdmin,
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
import {
  createClientProfile,
  getClientProfile,
  getClientProfileByIdForAdmin,
  getClientProfilesByUserId,
  softDeleteClientProfile,
  updateClientProfile,
} from './repositories/client-profiles-repository.js';
import type { ClientProfileWithStats } from './repositories/client-profiles-repository.js';
import {
  createClientFollowUp,
  getClientFollowUpsByClientId,
  softDeleteClientFollowUp,
} from './repositories/client-follow-ups-repository.js';
import {
  getBaziCaseById,
  getBaziCasesOverview,
  listBaziCasesPage,
} from './repositories/bazi-cases-repository.js';
import type {
  BaziCaseRow,
  BaziCaseFullRow,
  BaziCasesOverview,
  BaziCasesPage,
  BaziCaseDistributionRow,
} from './repositories/bazi-cases-repository.js';
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
  purgeExpiredTraceEvents,
  storeConversationLog,
} from './repositories/conversation-log-repository.js';
import {
  createPublicFinancialLedgerEntry,
  deletePublicFinancialLedgerEntry,
  listPublicFinancialLedgerEntries,
  updatePublicFinancialLedgerEntry,
} from './repositories/public-financial-ledger-repository.js';
import {
  createUser,
  createUserUsing,
  listUsersPageForAdmin,
  getUserByAccountId,
  getUserById,
  getUserByOAuthIdentityUsing,
  getUserByPhone,
  getUserSoulEditEnabled,
  getUserSoulContent,
  getUserGuashiScriptTemplate,
  updateUserSoulEditEnabled,
  updateUserPasswordHash,
  updateUserSoulContent,
  updateUserGuashiScriptTemplate,
  upsertOAuthIdentityUsing,
} from './repositories/users-repository.js';
import {
  createSkillBundle,
  createSkillAccessInvite,
  createUserCustomSkill,
  deleteSkillBundle,
  deleteUserCustomSkill,
  getAllSkillGlobalConfigs,
  getBundleByToken,
  getResolvedEnabledOfficialSkillNames,
  getSkillAccessInvitePreviewByToken,
  getSkillByShareToken,
  getSubscribedSkills,
  getUserCustomSkill,
  getUserCustomSkillById,
  getUserCustomSkillCount,
  getUserCustomSkills,
  listAdminSkillBundleSummaries,
  listMarketBundles,
  listMarketSkills,
  listSkillCommentsForAdmin,
  listSkillAccessInvites,
  listUserBundles,
  publishSkillBundle,
  publishUserCustomSkill,
  redeemSkillAccessInvite,
  resolveSkillAccessInviteStatus,
  revokeSkillAccessInvite,
  reviewSkillCommentForAdmin,
  seedOfficialSkills,
  setUserCustomSkillAdminState,
  setSkillCommentPinnedForAdmin,
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
  AdminSkillCommentRow,
  RedeemSkillAccessInviteResult,
  SkillAccessInvitePreviewResult,
} from './repositories/skills-repository.js';

export {
  countActiveUserApiKeys,
  createUserApiKey,
  findActiveApiKeyByHash,
  hashApiKey,
  listUserApiKeys,
  revokeUserApiKey,
  toApiKeyDto,
  touchApiKeyLastUsed,
  createOpenSession,
  findOpenSessionByIdForUser,
  softDeleteOpenSession,
  toOpenSessionDto,
  touchOpenSessionActivity,
  adjustUserPurchasedBalance,
  archiveChatSession,
  bindAccountToUser,
  cancelUserMembershipsForAdmin,
  createAccount,
  createAnnouncement,
  createChatSession,
  createConfigAuditLog,
  createOfficialModelConfig,
  createPublicFinancialLedgerEntry,
  createSkillBundle,
  createSkillAccessInvite,
  createUser,
  createUserUsing,
  createUserCustomSkill,
  createClientProfile,
  createClientFollowUp,
  getClientFollowUpsByClientId,
  softDeleteClientFollowUp,
  getBaziCaseById,
  getBaziCasesOverview,
  listBaziCasesPage,
  deleteAccount,
  deleteDraftAnnouncement,
  deleteConversationLogsByAccountIds,
  deleteOfficialModelConfig,
  deletePublicFinancialLedgerEntry,
  deleteSkillBundle,
  deleteUserCustomSkill,
  deleteUserModelSelectionsByOfficialModelId,
  deleteWechatChatSessionLink,
  expireUserBonusBalanceBefore,
  getAccount,
  getAccountCountsByOwnerIds,
  getAccountsByUserId,
  getActiveAnnouncement,
  getAdminAnnouncementById,
  getAdminGlobalStats,
  getAllSkillGlobalConfigs,
  getAllAccounts,
  getSingleAccountIdIfOnlyOne,
  getArchivedChatSessionsByUserId,
  getBillingRequestReservationByRequestId,
  getBundleByToken,
  getChatSession,
  getChatSessionByIdForAdmin,
  getChatSessionPiSessionArchive,
  getChatSessionPiArchiveStates,
  getChatSessionPiCleanupCandidates,
  getChatSessionsByClientId,
  getChatSessionsByUserId,
  getChatSessionsForAdmin,
  getClientProfile,
  getClientProfileByIdForAdmin,
  getClientProfilesByUserId,
  getConversationLogById,
  getConversationLogByRequestId,
  getConversationLogSummaries,
  getCustomSkillForAdmin,
  getCustomSkillsForAdmin,
  getEnabledAccounts,
  getMembershipEntitlements,
  getMembershipConfig,
  getMembershipPlanConfigs,
  getMembershipOverview,
  getMembershipOverviewsByUserIds,
  getMonthlyModelChargeCoins,
  getMonthlyModelChargeCoinsByUserIds,
  getMessagesForAdmin,
  getModelBillingConfig,
  getOfficialModelConfig,
  getPiSessionCleanupCursor,
  getPublicAnnouncementBySlug,
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
  getSessionMessagesForAdmin,
  getSessionMessagesWithToolContext,
  getSharedChatSessionByToken,
  hasFinalAiChatSessionReply,
  getSkillAccessInvitePreviewByToken,
  getSkillByShareToken,
  getSoulContent,
  getSubscribedSkills,
  getSystemSecret,
  getUserByAccountId,
  getUserById,
  getUserByOAuthIdentityUsing,
  getUserByPhone,
  getUserSoulEditEnabled,
  getUserSoulContent,
  getUserGuashiScriptTemplate,
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
  listBillingRequestReservationsPageForAdmin,
  listStalePendingReservations,
  listAdminAnnouncements,
  listAdminSkillBundleSummaries,
  listConfigAuditLogs,
  listMarketBundles,
  listMarketSkills,
  listSkillCommentsForAdmin,
  listOfficialModelConfigs,
  listPublicAnnouncements,
  listPublicFinancialLedgerEntries,
  listRechargeOrdersForAdmin,
  listRechargeOrdersByUserId,
  listWalletTransactionsForAdmin,
  listSkillAccessInvites,
  listUsersPageForAdmin,
  listUserBundles,
  markChatSessionPiSessionArchived,
  markChatSessionPiSessionArchiveRestored,
  markRechargeOrderFailed,
  markRechargeOrderPaymentCreated,
  publishSkillBundle,
  publishUserCustomSkill,
  purgeExpiredTraceEvents,
  reconcileStaleBillingReservations,
  redeemSkillAccessInvite,
  resolveSkillAccessInviteStatus,
  resetPiSessionCleanupCursor,
  resetUserMessages,
  restoreArchivedChatSession,
  revokeSkillAccessInvite,
  reviewSkillCommentForAdmin,
  reserveUserBalanceCoins,
  seedOfficialSkills,
  setSkillGlobalEnabled,
  setSkillCommentPinnedForAdmin,
  setUserCustomSkillAdminState,
  shareOwnedChatSession,
  shareSkillBundle,
  shareUserCustomSkill,
  settleRechargeOrderPaid,
  settleUserModelChargeCoins,
  setUserMembershipForAdmin,
  softDeleteClientProfile,
  subscribeMembershipWithWallet,
  subscribeToBundle,
  subscribeToSkill,
  storeMessage,
  storeConversationLog,
  touchChatSession,
  touchWechatChatSessionLink,
  toggleSubscription,
  toggleUserCustomSkill,
  updateModelBillingConfig,
  updateAccount,
  updateAnnouncement,
  updateChatSessionTitle,
  updateClientProfile,
  updateMembershipConfig,
  updateOfficialModelConfig,
  updatePublicFinancialLedgerEntry,
  updateRuntimeConfig,
  updateSoulContent,
  updateRechargePaymentConfig,
  updateSkillBundle,
  updateUserCustomSkill,
  updateUserPasswordHash,
  updateUserSoulEditEnabled,
  updateUserSoulContent,
  updateUserGuashiScriptTemplate,
  upsertOAuthIdentityUsing,
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
  AdminSkillCommentRow,
  BaziCaseRow,
  BaziCaseFullRow,
  BaziCasesOverview,
  BaziCasesPage,
  BaziCaseDistributionRow,
  ClientProfileWithStats,
  MembershipEntitlementRow,
  RechargeOrderRow,
  RechargePayType,
  RechargePaymentConfigRow,
  RechargeStatsRow,
  RedeemSkillAccessInviteResult,
  SkillAccessInvitePreviewResult,
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

    // 站内 AI Chat 使用 web:{userId}，不再依赖 accounts 行。
    const webAccountId = `web:${userId}`;

    // 删除用户拥有的账号链路
    await client.query(
      `DELETE FROM conversation_logs
       WHERE account_id = $1
          OR account_id IN (SELECT id FROM accounts WHERE owner_id = $2)`,
      [webAccountId, userId],
    );
    await client.query(
      `DELETE FROM messages
       WHERE user_id = $1
          OR account_id = $2
          OR account_id IN (SELECT id FROM accounts WHERE owner_id = $1)`,
      [userId, webAccountId],
    );
    await client.query(
      `DELETE FROM chat_sessions
       WHERE user_id = $1
          OR account_id = $2
          OR account_id IN (SELECT id FROM accounts WHERE owner_id = $1)`,
      [userId, webAccountId],
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
  const accountIds = Array.from(
    new Set([...userAccounts.map((a) => a.id), `web:${userId}`]),
  );

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE messages
       SET deleted_at = $1
       WHERE deleted_at IS NULL
         AND (
           user_id = $2
           OR account_id = ANY($3::text[])
         )`,
      [now, userId, accountIds],
    );

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
