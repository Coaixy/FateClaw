import pg from 'pg';

import { DATABASE_URL } from './config.js';
import {
  closeDbPool,
  getDbPool as getSharedDbPool,
  initDbPool,
} from './db-pool.js';
import { runDatabaseMigrations } from './migrations/runner.js';
import { logger } from './logger.js';
import { importLegacySkillContent } from '../modules/skills/legacy-skill-import.js';
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
  getOpenSessionForUserAnyStatus,
  listOpenSessionsByUserId,
  purgeExpiredOpenSessions,
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
  MembershipSubscribeDebounceError,
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
  mergeMessageMetadata,
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
  deleteWechatChatSessionLink,
  getWechatChatSessionLink,
  touchWechatChatSessionLink,
  upsertWechatChatSessionLink,
} from './repositories/wechat-session-link-repository.js';
import {
  createConfigAuditLog,
  getPlatformModelSettings,
  getPlatformModelRuntimeSettings,
  savePlatformModelConfig,
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
  createUser,
  createUserUsing,
  listUsersPageForAdmin,
  getUserByAccountId,
  getUserById,
  getUserByPhone,
  getUserSoulEditEnabled,
  getUserSoulContent,
  updateUserSoulEditEnabled,
  updateUserPasswordHash,
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
  getResolvedEnabledOfficialSkillNames,
  getSkillAccessInvitePreviewByToken,
  getSkillByShareToken,
  getSubscribedSkills,
  getUserCustomSkill,
  getUserCustomSkillById,
  getUserCustomSkillCount,
  getUserCustomSkills,
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
  getOpenSessionForUserAnyStatus,
  listOpenSessionsByUserId,
  softDeleteOpenSession,
  toOpenSessionDto,
  touchOpenSessionActivity,
  adjustUserPurchasedBalance,
  archiveChatSession,
  bindAccountToUser,
  cancelUserMembershipsForAdmin,
  createAccount,
  createChatSession,
  createConfigAuditLog,
  createSkillBundle,
  createSkillAccessInvite,
  createUser,
  createUserUsing,
  createUserCustomSkill,
  createClientProfile,
  createClientFollowUp,
  getClientFollowUpsByClientId,
  softDeleteClientFollowUp,
  deleteAccount,
  deleteConversationLogsByAccountIds,
  deleteSkillBundle,
  deleteUserCustomSkill,
  deleteWechatChatSessionLink,
  expireUserBonusBalanceBefore,
  getAccount,
  getAccountCountsByOwnerIds,
  getAccountsByUserId,
  getAdminGlobalStats,
  getAllSkillGlobalConfigs,
  getAllAccounts,
  getSingleAccountIdIfOnlyOne,
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
  getPiSessionCleanupCursor,
  getBalanceGrantsByUserId,
  getRechargeOrderByTradeId,
  getRechargeOrderByTradeIdForUser,
  getRechargePaymentConfig,
  getRechargeStatsByUserId,
  getRecentMessages,
  getResolvedEnabledOfficialSkillNames,
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
  getPlatformModelSettings,
  getPlatformModelRuntimeSettings,
  getUserByAccountId,
  getUserById,
  getUserByPhone,
  getUserSoulEditEnabled,
  getUserSoulContent,
  getUserCustomSkill,
  getUserCustomSkillById,
  getUserCustomSkillCount,
  getUserCustomSkills,
  getWechatChatSessionLink,
  getVisibleWalletTransactionsByUserId,
  getWalletTransactionsByUserId,
  grantBonusBalance,
  insertRechargeOrder,
  listBillingRequestReservations,
  listBillingRequestReservationsPageForAdmin,
  listStalePendingReservations,
  listMarketBundles,
  listMarketSkills,
  listSkillCommentsForAdmin,
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
  purgeExpiredOpenSessions,
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
  savePlatformModelConfig,
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
  MembershipSubscribeDebounceError,
  subscribeMembershipWithWallet,
  subscribeToBundle,
  subscribeToSkill,
  mergeMessageMetadata,
  storeMessage,
  storeConversationLog,
  touchChatSession,
  touchWechatChatSessionLink,
  toggleSubscription,
  toggleUserCustomSkill,
  updateAccount,
  updateChatSessionTitle,
  updateClientProfile,
  updateMembershipConfig,
  updateSoulContent,
  updateRechargePaymentConfig,
  updateSkillBundle,
  updateUserCustomSkill,
  updateUserPasswordHash,
  updateUserSoulEditEnabled,
  updateUserSoulContent,
  unpublishSkillBundle,
  unpublishUserCustomSkill,
  unsubscribeFromBundle,
  unsubscribeFromSkill,
  unshareSkillBundle,
  unshareUserCustomSkill,
  upsertPiSessionCleanupCursor,
  upsertWechatChatSessionLink,
};
export type {
  AdminSkillCommentRow,
  ClientProfileWithStats,
  MembershipEntitlementRow,
  RechargeOrderRow,
  RechargePayType,
  RechargePaymentConfigRow,
  RechargeStatsRow,
  RedeemSkillAccessInviteResult,
  SkillAccessInvitePreviewResult,
};
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
    // 无效手机号用户清理已改为一次性迁移（0071），由 runDatabaseMigrations 幂等执行，
    // 不再每次启动无条件重跑破坏性硬删除。
    await runDatabaseMigrations(client);
    const skillBackfill = await importLegacySkillContent(pool);
    if (skillBackfill.migrated > 0) {
      logger.info(
        skillBackfill,
        'User skill bundle database backfill completed',
      );
    }
    if (
      skillBackfill.missing > 0 ||
      skillBackfill.mismatched > 0 ||
      skillBackfill.invalid > 0
    ) {
      logger.warn(
        skillBackfill,
        'User skill bundles still need backfill; restore complete original files and restart this version on their deployment',
      );
    }
  } finally {
    client.release();
  }
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
