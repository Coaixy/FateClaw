/**
 * 管理后台服务层。
 *
 * 对外暴露管理端需要的领域能力，避免 route 直接拼装
 * 数据库、系统配置与套餐模块的细节。
 */

import crypto from 'node:crypto';

import bcrypt from 'bcryptjs';
import type {
  AdminStatusStatsDto,
  MembershipEntitlementDto,
  MembershipPlanDto,
  MembershipStatusDto,
} from '@fateclaw/contracts/billing';

import {
  adjustUserPurchasedBalance,
  cancelUserMembershipsForAdmin,
  createAnnouncement,
  createGiftCodesForAdmin,
  createPublicFinancialLedgerEntry,
  createUser,
  deleteDraftAnnouncement,
  deletePublicFinancialLedgerEntry,
  deleteConversationLogsByAccountIds,
  deleteUser,
  getAccountCountsByOwnerIds,
  getAccountsByUserId,
  getAdminGlobalStats,
  getAdminAnnouncementById,
  getAllSkillGlobalConfigs,
  getChatSessionPiArchiveStates,
  getChatSessionPiCleanupCandidates,
  getChatSessionPiSessionArchive,
  getChatSessionsForAdmin,
  getConversationLogById,
  getConversationLogByRequestId,
  getConversationLogSummaries,
  getRecentMessages,
  getCustomSkillForAdmin,
  getCustomSkillsForAdmin,
  getMessagesForAdmin,
  getFreeProfessionalAiQuotaConfig,
  listGiftCodesForAdmin,
  getMembershipConfig,
  getMembershipEntitlements,
  getMembershipPlanConfigs,
  getBalanceGrantsByUserId,
  getDailySignInConfig,
  getReferralConfig,
  getPiSessionCleanupCursor,
  getUserById,
  getUserByPhone,
  getUserCustomSkillById,
  getWalletTransactionsByUserId,
  grantBonusBalance,
  listAdminAnnouncements,
  listAdminSkillBundleSummaries,
  listAdminWorkflowSkillSummaries,
  listUsersPageForAdmin,
  listBillingRequestReservations,
  listBillingRequestReservationsPageForAdmin,
  listPublicFinancialLedgerEntries,
  listRechargeOrdersForAdmin,
  listReferralsForAdmin,
  listSimpleWorkflowPresets,
  listWalletTransactionsForAdmin,
  markChatSessionPiSessionArchived,
  reconcileStaleBillingReservations,
  resetPiSessionCleanupCursor,
  setSkillGlobalEnabled,
  setUserCustomSkillAdminState,
  setUserMembershipForAdmin,
  upsertPiSessionCleanupCursor,
  updateDailySignInConfig,
  updateFreeProfessionalAiQuotaConfig,
  updateMembershipConfig,
  updateUserPasswordHash,
  updateAnnouncement,
  updatePublicFinancialLedgerEntry,
  updateReferralConfig,
  updateSimpleWorkflowPreset,
} from '../../infrastructure/db.js';
import type {
  AdminReferralListResult,
  ReferralRewardStatus,
} from '../../infrastructure/db.js';
import {
  MEMBERSHIP_INSIGHT_PLAN_KEY,
  normalizeMembershipPlanKey,
  type MembershipPlanKey,
} from '../../shared/membership-plans.js';
import {
  getAdminStatusStats,
  getUsageStats,
  getUsageStatsByUserIds,
} from '../../infrastructure/daily-usage.js';
import {
  createOfficialModel,
  getPiSessionHealthPolicy,
  getSystemConfigOverview,
  removeOfficialModel,
  updateModelBillingSettings,
  updateRuntimeSettings,
  updateOfficialModel,
} from '../system/system-config.js';
import {
  getMembershipBillingSummary,
  getMembershipBillingSummariesByUserIds,
  getMembershipPlanSummaries,
  getMonthlyMeteredBillingSummary,
  getMonthlyMeteredBillingSummariesByUserIds,
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
  deletePiSessionOrphanFiles,
  readPiSessionArchiveForSession,
  readPiSessionSnapshotFromTraceEvents,
  scanPiSessionOrphanFiles,
  writePiSessionSnapshotArchiveToFiles,
  type PiSessionArchivePayload,
  type PiSessionOrphanFileEntry,
} from '../chat/pi-session-files.js';
import {
  isValidMainlandChinaPhone,
  normalizePhoneNumber,
} from '../user/phone.js';
import { resolveMembershipPlanKey } from '../../shared/membership-plans.js';
import type { User, UserRole } from '../../shared/types.js';

const ADMIN_CREATE_USER_SALT_ROUNDS = 10;
const ADMIN_CREATE_USER_PASSWORD_MIN_LENGTH = 8;

export {
  adjustUserPurchasedBalance,
  cancelUserMembershipsForAdmin,
  createAnnouncement,
  createOfficialModel,
  createPublicFinancialLedgerEntry,
  createGiftCodesForAdmin,
  deleteConversationLogsByAccountIds,
  deleteDraftAnnouncement,
  deletePublicFinancialLedgerEntry,
  deleteUser,
  getAdminGlobalStats,
  getAdminAnnouncementById,
  getAdminRechargePaymentConfig,
  getChatSessionsForAdmin,
  getConversationLogById,
  getConversationLogByRequestId,
  getConversationLogSummaries,
  getCustomSkillForAdmin,
  getCustomSkillsForAdmin,
  getMessagesForAdmin,
  getBalanceGrantsByUserId,
  getReferralConfig,
  getSystemConfigOverview,
  getUserById,
  getUserCustomSkillById,
  getWalletTransactionsByUserId,
  grantBonusBalance,
  listAdminAnnouncements,
  listAdminSkillBundleSummaries,
  listAdminWorkflowSkillSummaries,
  listBillingRequestReservations,
  listBillingRequestReservationsPageForAdmin,
  listGiftCodesForAdmin,
  listPublicFinancialLedgerEntries,
  listRechargeOrdersForAdmin,
  listReferralsForAdmin,
  listSimpleWorkflowPresets,
  listWalletTransactionsForAdmin,
  reconcileStaleBillingReservations,
  removeOfficialModel,
  setSkillGlobalEnabled,
  setUserCustomSkillAdminState,
  setUserMembershipForAdmin,
  updateModelBillingSettings,
  updateAnnouncement,
  updateRuntimeSettings,
  updateOfficialModel,
  updateAdminRechargePaymentConfig,
  updatePublicFinancialLedgerEntry,
  updateReferralConfig,
  updateSimpleWorkflowPreset,
};

/** 管理后台用户会员状态组合视图。 */
export interface AdminUserMembershipState {
  membership: MembershipStatusDto;
  membership_entitlements: MembershipEntitlementDto[];
  membership_plans: MembershipPlanDto[];
}

/** 管理后台积分奖励配置视图。 */
export interface AdminRewardConfigView {
  daily_sign_in: {
    enabled: boolean;
    reward_coins: number;
    updated_at: string;
  };
  membership: {
    plan_key: string;
    name: string;
    enabled: boolean;
    monthly_price_coins: number;
    display_price_coins: number;
    monthly_allowance_units: number;
    standard_price_per_million_units_coins: number;
    updated_at: string;
  };
  membership_plans: Array<{
    plan_key: string;
    name: string;
    enabled: boolean;
    monthly_price_coins: number;
    display_price_coins: number;
    monthly_allowance_units: number;
    standard_price_per_million_units_coins: number;
    updated_at: string;
  }>;
  free_professional_ai: {
    daily_turn_limit: number;
    updated_at: string;
  };
}

export interface AdminUserListOptions {
  page?: number;
  pageSize?: number;
  query?: string;
}

export type AdminUserListItem = Omit<User, 'password_hash'> & {
  account_count: number;
  usage: Awaited<ReturnType<typeof getUsageStats>>;
  monthly_tokens_used: number;
  estimated_monthly_total_coins: number;
  purchased_coins: number;
  bonus_coins: number;
  reserved_coins: number;
  available_coins: number;
  membership: MembershipStatusDto;
};

export interface AdminUsersPageResult {
  items: AdminUserListItem[];
  total: number;
  page: number;
  page_size: number;
}

const ADMIN_USERS_DEFAULT_PAGE_SIZE = 50;
const ADMIN_USERS_MAX_PAGE_SIZE = 100;

/**
 * 读取管理后台完整运行状态统计。
 *
 * @returns 全站消息、用户、队列和 Token 趋势指标。
 */
export async function getAdminStatusOverview(): Promise<AdminStatusStatsDto> {
  return getAdminStatusStats();
}

function membershipPlanKeyFromConfigId(configId: string) {
  return resolveMembershipPlanKey(configId);
}

function membershipConfigToAdminView(
  config: Awaited<ReturnType<typeof getMembershipConfig>>,
) {
  return {
    plan_key: membershipPlanKeyFromConfigId(config.id),
    name: config.name,
    enabled: config.enabled,
    monthly_price_coins: config.monthly_price_coins,
    display_price_coins: config.display_price_coins,
    monthly_allowance_units: config.monthly_allowance_units,
    standard_price_per_million_units_coins:
      config.standard_price_per_million_units_coins,
    updated_at: config.updated_at,
  };
}

function membershipStatusToAdminView(
  membership: Awaited<ReturnType<typeof getMembershipBillingSummary>>,
): MembershipStatusDto {
  return {
    enabled: membership.enabled,
    active: membership.active,
    plan_key: membership.planKey,
    monthly_price_coins: membership.monthlyPriceCoins,
    display_price_coins: membership.displayPriceCoins,
    current_period_start: membership.currentPeriodStart,
    current_period_end: membership.currentPeriodEnd,
    allowance_reset_at: membership.allowanceResetAt,
    allowance_used_ratio: membership.allowanceUsedRatio,
    allowance_status: membership.allowanceStatus,
  };
}

function membershipPlanToAdminView(
  plan: Awaited<ReturnType<typeof getMembershipPlanSummaries>>[number],
): MembershipPlanDto {
  return {
    plan_key: plan.planKey,
    name: plan.name,
    enabled: plan.enabled,
    monthly_price_coins: plan.monthlyPriceCoins,
    display_price_coins: plan.displayPriceCoins,
    monthly_allowance_units: plan.monthlyAllowanceUnits,
    standard_price_per_million_units_coins:
      plan.standardPricePerMillionUnitsCoins,
    updated_at: plan.updatedAt,
  };
}

async function getAdminUserMembershipState(
  userId: string,
): Promise<AdminUserMembershipState> {
  const [membership, entitlements, plans] = await Promise.all([
    getMembershipBillingSummary(userId),
    getMembershipEntitlements(userId),
    getMembershipPlanSummaries(),
  ]);
  return {
    membership: membershipStatusToAdminView(membership),
    membership_entitlements: entitlements,
    membership_plans: plans.map(membershipPlanToAdminView),
  };
}

/**
 * 读取后台积分奖励配置。
 */
export async function getAdminRewardConfig(): Promise<AdminRewardConfigView> {
  const [dailySignIn, membership, membershipPlans, freeProfessionalAi] =
    await Promise.all([
      getDailySignInConfig(),
      getMembershipConfig(),
      getMembershipPlanConfigs(),
      getFreeProfessionalAiQuotaConfig(),
    ]);
  const membershipView = membershipConfigToAdminView(membership);
  return {
    daily_sign_in: {
      enabled: dailySignIn.enabled,
      reward_coins: dailySignIn.reward_coins,
      updated_at: dailySignIn.updated_at,
    },
    membership: membershipView,
    membership_plans: membershipPlans.map(membershipConfigToAdminView),
    free_professional_ai: {
      daily_turn_limit: freeProfessionalAi.daily_professional_turn_limit,
      updated_at: freeProfessionalAi.updated_at,
    },
  };
}

/**
 * 更新后台积分奖励配置。
 */
export async function updateAdminRewardConfig(input: {
  dailySignIn: {
    enabled: boolean;
    rewardCoins: number;
  };
  membership: {
    planKey?: string;
    name?: string;
    enabled: boolean;
    monthlyPriceCoins: number;
    displayPriceCoins?: number;
    monthlyAllowanceUnits: number;
    standardPricePerMillionUnitsCoins: number;
  };
  membershipPlans?: Array<{
    planKey: string;
    name: string;
    enabled: boolean;
    monthlyPriceCoins: number;
    displayPriceCoins: number;
    monthlyAllowanceUnits: number;
    standardPricePerMillionUnitsCoins: number;
  }>;
  freeProfessionalAi?: {
    dailyTurnLimit: number;
  };
}): Promise<AdminRewardConfigView> {
  const membershipInputs =
    input.membershipPlans && input.membershipPlans.length > 0
      ? input.membershipPlans
      : [input.membership];
  const [dailySignIn, freeProfessionalAi] = await Promise.all([
    updateDailySignInConfig({
      enabled: input.dailySignIn.enabled,
      rewardCoins: input.dailySignIn.rewardCoins,
    }),
    input.freeProfessionalAi
      ? updateFreeProfessionalAiQuotaConfig({
          dailyProfessionalTurnLimit: input.freeProfessionalAi.dailyTurnLimit,
        })
      : getFreeProfessionalAiQuotaConfig(),
  ]);
  await Promise.all(
    membershipInputs.map((membershipInput) =>
      updateMembershipConfig({
        planKey: membershipInput.planKey,
        name: membershipInput.name,
        enabled: membershipInput.enabled,
        monthlyPriceCoins: membershipInput.monthlyPriceCoins,
        displayPriceCoins: membershipInput.displayPriceCoins,
        monthlyAllowanceUnits: membershipInput.monthlyAllowanceUnits,
        standardPricePerMillionUnitsCoins:
          membershipInput.standardPricePerMillionUnitsCoins,
      }),
    ),
  );
  const membershipPlans = await getMembershipPlanConfigs();
  const membership = membershipPlans[0];
  const membershipView = membershipConfigToAdminView(membership);
  return {
    daily_sign_in: {
      enabled: dailySignIn.enabled,
      reward_coins: dailySignIn.reward_coins,
      updated_at: dailySignIn.updated_at,
    },
    membership: membershipView,
    membership_plans: membershipPlans.map(membershipConfigToAdminView),
    free_professional_ai: {
      daily_turn_limit: freeProfessionalAi.daily_professional_turn_limit,
      updated_at: freeProfessionalAi.updated_at,
    },
  };
}

/** 管理后台邀请配置视图。 */
export interface AdminReferralConfigView {
  enabled: boolean;
  reward_membership_plan_key: MembershipPlanKey;
  inviter_reward_days: number;
  monthly_reward_cap_days: number;
  reward_first_membership_only: boolean;
  invite_count_reward_threshold: number;
  invite_count_reward_days: number;
  invite_count_reward_max_invites: number;
  updated_at: string;
}

/**
 * 读取后台邀请配置。
 */
export async function getAdminReferralConfig(): Promise<AdminReferralConfigView> {
  const config = await getReferralConfig();
  return {
    enabled: config.enabled,
    reward_membership_plan_key: config.reward_membership_plan_key,
    inviter_reward_days: config.inviter_reward_days,
    monthly_reward_cap_days: config.monthly_reward_cap_days,
    reward_first_membership_only: config.reward_first_membership_only,
    invite_count_reward_threshold: config.invite_count_reward_threshold,
    invite_count_reward_days: config.invite_count_reward_days,
    invite_count_reward_max_invites: config.invite_count_reward_max_invites,
    updated_at: config.updated_at,
  };
}

/**
 * 更新后台邀请配置。
 */
export async function updateAdminReferralConfig(input: {
  enabled: boolean;
  rewardMembershipPlanKey?: MembershipPlanKey;
  inviterRewardDays: number;
  monthlyRewardCapDays: number;
  rewardFirstMembershipOnly: boolean;
  inviteCountRewardThreshold: number;
  inviteCountRewardDays: number;
  inviteCountRewardMaxInvites: number;
}): Promise<AdminReferralConfigView> {
  const config = await updateReferralConfig({
    ...input,
    rewardMembershipPlanKey: normalizeMembershipPlanKey(
      input.rewardMembershipPlanKey,
      MEMBERSHIP_INSIGHT_PLAN_KEY,
    ),
  });
  return {
    enabled: config.enabled,
    reward_membership_plan_key: config.reward_membership_plan_key,
    inviter_reward_days: config.inviter_reward_days,
    monthly_reward_cap_days: config.monthly_reward_cap_days,
    reward_first_membership_only: config.reward_first_membership_only,
    invite_count_reward_threshold: config.invite_count_reward_threshold,
    invite_count_reward_days: config.invite_count_reward_days,
    invite_count_reward_max_invites: config.invite_count_reward_max_invites,
    updated_at: config.updated_at,
  };
}

function maskAdminPhone(phone: string | null): string | null {
  if (!phone || phone.length < 7) return phone;
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

/**
 * 查询后台邀请关系列表。
 */
export async function listAdminReferrals(input: {
  inviterId?: string;
  inviteeId?: string;
  rewardStatus?: ReferralRewardStatus;
  limit?: number;
  offset?: number;
}): Promise<AdminReferralListResult> {
  const result = await listReferralsForAdmin(input);
  return {
    total: result.total,
    referrals: result.referrals.map((row) => ({
      ...row,
      inviter_phone: maskAdminPhone(row.inviter_phone),
      invitee_phone: maskAdminPhone(row.invitee_phone),
    })),
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
  payload_restored_from_snapshot: number;
  unarchivable_sessions: number;
  already_archived_sessions: number;
  touched_sessions: number;
  deleted_jsonl_files: number;
  deleted_path_files: number;
  missing_jsonl_files: number;
  skipped_unsafe_files: string[];
}

export type AdminPiSessionOrphanScanAction = 'audit' | 'delete';

/** 管理后台 Pi session 孤儿文件扫描/清理结果。 */
export interface AdminPiSessionOrphanScanResult {
  success: true;
  action: AdminPiSessionOrphanScanAction;
  grace_days: number;
  session_dir: string;
  total_files: number;
  scanned_files: number;
  truncated: boolean;
  scanned_path_files: number;
  scanned_jsonl_files: number;
  dangling_path_files: number;
  unmapped_jsonl_files: number;
  unknown_files: number;
  unsafe_path_files: number;
  safe_deletable_files: number;
  deleted_path_files: number;
  deleted_jsonl_files: number;
  skipped_recent_files: number;
  skipped_unarchived_files: number;
  skipped_unmapped_session_files: number;
  samples: {
    dangling_path_files: string[];
    unmapped_jsonl_files: string[];
    unknown_files: string[];
    unsafe_path_files: string[];
    safe_deletable_files: string[];
    skipped_recent_files: string[];
    skipped_unarchived_files: string[];
    skipped_unmapped_session_files: string[];
  };
}

type PiSessionCleanupMode = 'soft_deleted' | 'inactive';

type PiSessionCleanupPayloadResolution = {
  payload: PiSessionArchivePayload;
  source: 'existing_payload' | 'local_files' | 'snapshot';
  missingSessionFile: boolean;
  skippedUnsafeSessionFiles: string[];
  shouldMarkArchived: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSafeJsonlArchiveFile(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const name = value.name;
  const content = value.content;
  return (
    typeof name === 'string' &&
    name.trim().length > 0 &&
    !name.includes('/') &&
    !name.includes('\\') &&
    name.endsWith('.jsonl') &&
    typeof content === 'string' &&
    content.length > 0
  );
}

function hasUsablePiSessionArchivePayload(
  payload: unknown,
): payload is PiSessionArchivePayload {
  if (!isRecord(payload) || !Array.isArray(payload.files)) {
    return false;
  }
  return payload.files.some((file) => isSafeJsonlArchiveFile(file));
}

function readRequestIdFromMessageMetadata(message: {
  metadata?: unknown;
}): string | null {
  const metadata = isRecord(message.metadata) ? message.metadata : null;
  const requestId = metadata?.request_id;
  return typeof requestId === 'string' && requestId.trim()
    ? requestId.trim()
    : null;
}

async function restorePiSessionPayloadFromConversationSnapshot(input: {
  sessionId: string;
  accountId: string;
}): Promise<PiSessionCleanupPayloadResolution | null> {
  const recentMessages = await getRecentMessages(
    input.accountId,
    50,
    undefined,
    undefined,
    input.sessionId,
  );
  const requestIds = Array.from(
    new Set(
      recentMessages
        .map(readRequestIdFromMessageMetadata)
        .filter((requestId): requestId is string => Boolean(requestId)),
    ),
  );

  for (const requestId of requestIds) {
    const log = await getConversationLogByRequestId(requestId);
    if (!log || log.account_id !== input.accountId) {
      continue;
    }
    const snapshot = readPiSessionSnapshotFromTraceEvents(log.trace_events);
    if (!snapshot) {
      continue;
    }
    const restored = await writePiSessionSnapshotArchiveToFiles(
      input.sessionId,
      snapshot,
    );
    if (!restored || !hasUsablePiSessionArchivePayload(restored.payload)) {
      continue;
    }
    return {
      payload: restored.payload,
      source: 'snapshot',
      missingSessionFile: true,
      skippedUnsafeSessionFiles: [],
      shouldMarkArchived: true,
    };
  }

  return null;
}

async function resolvePiSessionCleanupPayload(input: {
  sessionId: string;
  accountId: string;
  piSessionArchivedAt: string | null;
}): Promise<PiSessionCleanupPayloadResolution | null> {
  const existingArchive = await getChatSessionPiSessionArchive(input.sessionId);
  if (
    existingArchive &&
    hasUsablePiSessionArchivePayload(existingArchive.pi_session_archive_payload)
  ) {
    return {
      payload: existingArchive.pi_session_archive_payload,
      source: 'existing_payload',
      missingSessionFile: false,
      skippedUnsafeSessionFiles: [],
      shouldMarkArchived: !input.piSessionArchivedAt,
    };
  }

  const archive = await readPiSessionArchiveForSession(input.sessionId);
  if (hasUsablePiSessionArchivePayload(archive.payload)) {
    return {
      payload: archive.payload,
      source: 'local_files',
      missingSessionFile: archive.missingSessionFile,
      skippedUnsafeSessionFiles: archive.skippedUnsafeSessionFiles,
      shouldMarkArchived: true,
    };
  }

  return restorePiSessionPayloadFromConversationSnapshot({
    sessionId: input.sessionId,
    accountId: input.accountId,
  });
}

/**
 * 清理站内 AI Chat 的 Pi session 本地文件。
 *
 * @param input - 清理模式和管理员填写的未活跃天数。
 * @returns 清理统计，供后台确认实际影响范围。
 */
export async function cleanupPiSessionFilesForAdmin(input: {
  mode: PiSessionCleanupMode;
  inactiveDays?: number;
  limit?: number;
}): Promise<AdminPiSessionCleanupResult> {
  const policy =
    input.mode === 'inactive' && !input.inactiveDays
      ? await getPiSessionHealthPolicy()
      : null;
  const inactiveDays = input.inactiveDays ?? policy?.inactiveCleanupDays;
  const cutoffAt =
    input.mode === 'inactive' && inactiveDays
      ? new Date(Date.now() - inactiveDays * 86_400_000).toISOString()
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
  let payloadRestoredFromSnapshot = 0;
  let unarchivableSessions = 0;
  let alreadyArchivedSessions = 0;
  let touchedSessions = 0;
  let deletedJsonlFiles = 0;
  let deletedPathFiles = 0;
  let missingJsonlFiles = 0;
  const skippedUnsafeFiles: string[] = [];

  for (const candidate of candidates) {
    const resolution = await resolvePiSessionCleanupPayload({
      sessionId: candidate.id,
      accountId: candidate.account_id,
      piSessionArchivedAt: candidate.pi_session_archived_at,
    });
    if (!resolution) {
      unarchivableSessions += 1;
      continue;
    }

    if (resolution.shouldMarkArchived) {
      const archived = await markChatSessionPiSessionArchived({
        sessionId: candidate.id,
        reason: input.mode,
        payload: resolution.payload,
      });
      if (!archived) {
        continue;
      }
      if (resolution.source !== 'existing_payload') {
        archivedSessions += 1;
      }
    }
    if (resolution.source === 'existing_payload') {
      alreadyArchivedSessions += 1;
    }
    if (resolution.source === 'snapshot') {
      payloadRestoredFromSnapshot += 1;
    }

    missingJsonlFiles += resolution.missingSessionFile ? 1 : 0;
    skippedUnsafeFiles.push(...resolution.skippedUnsafeSessionFiles);

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
    inactive_days: input.mode === 'inactive' ? (inactiveDays ?? null) : null,
    cutoff_at: cutoffAt,
    cursor_before: cursorReset ? null : cursorBefore,
    cursor_after: cursorAfter,
    cursor_reset: cursorReset,
    scanned_sessions: candidates.length,
    archived_sessions: archivedSessions,
    payload_restored_from_snapshot: payloadRestoredFromSnapshot,
    unarchivable_sessions: unarchivableSessions,
    already_archived_sessions: alreadyArchivedSessions,
    touched_sessions: touchedSessions,
    deleted_jsonl_files: deletedJsonlFiles,
    deleted_path_files: deletedPathFiles,
    missing_jsonl_files: missingJsonlFiles,
    skipped_unsafe_files: skippedUnsafeFiles,
  };
}

function sampleEntryNames(
  entries: Array<PiSessionOrphanFileEntry | string>,
  sampleLimit: number,
): string[] {
  return entries
    .slice(0, sampleLimit)
    .map((entry) => (typeof entry === 'string' ? entry : entry.name));
}

function isOlderThanGraceDays(
  entry: PiSessionOrphanFileEntry,
  nowMs: number,
  graceDays: number,
): boolean {
  if (!entry.modified_at) {
    return false;
  }
  const modifiedAtMs = new Date(entry.modified_at).getTime();
  if (!Number.isFinite(modifiedAtMs)) {
    return false;
  }
  return nowMs - modifiedAtMs >= graceDays * 86_400_000;
}

/**
 * 扫描并按需物理删除 Pi session 孤儿文件。
 *
 * @param input - 管理员选择的动作和扫描上限。
 * @returns 文件系统审计、跳过原因和删除数量。
 * @remarks 只有 action=delete 时才会物理删除；自动后台任务不会调用删除动作。
 */
export async function scanPiSessionOrphanFilesForAdmin(input?: {
  action?: AdminPiSessionOrphanScanAction;
  limit?: number;
  sampleLimit?: number;
}): Promise<AdminPiSessionOrphanScanResult> {
  const action = input?.action ?? 'audit';
  const sampleLimit = Math.min(Math.max(input?.sampleLimit ?? 20, 1), 100);
  const policy = await getPiSessionHealthPolicy();
  const scan = await scanPiSessionOrphanFiles({ limit: input?.limit });
  const candidates = [
    ...scan.dangling_path_files,
    ...scan.unmapped_jsonl_files,
  ];
  const sessionIds = [
    ...new Set(
      candidates
        .map((entry) => entry.session_id)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const archiveStates = new Map(
    (await getChatSessionPiArchiveStates(sessionIds)).map((state) => [
      state.id,
      state,
    ]),
  );

  const nowMs = Date.now();
  const safeDeletableFiles: PiSessionOrphanFileEntry[] = [];
  const skippedRecentFiles: PiSessionOrphanFileEntry[] = [];
  const skippedUnarchivedFiles: PiSessionOrphanFileEntry[] = [];
  const skippedUnmappedSessionFiles: PiSessionOrphanFileEntry[] = [];

  for (const candidate of candidates) {
    if (!candidate.session_id) {
      skippedUnmappedSessionFiles.push(candidate);
      continue;
    }
    if (!isOlderThanGraceDays(candidate, nowMs, policy.orphanGraceDays)) {
      skippedRecentFiles.push(candidate);
      continue;
    }
    const archiveState = archiveStates.get(candidate.session_id);
    if (archiveState && !archiveState.has_pi_session_archive_payload) {
      skippedUnarchivedFiles.push(candidate);
      continue;
    }
    safeDeletableFiles.push(candidate);
  }

  const deleteResult =
    action === 'delete'
      ? await deletePiSessionOrphanFiles(safeDeletableFiles)
      : {
          deleted_path_files: 0,
          deleted_jsonl_files: 0,
          skipped_unsafe_files: [],
        };
  const unsafeFiles = [
    ...scan.unsafe_path_files,
    ...deleteResult.skipped_unsafe_files,
  ];

  return {
    success: true,
    action,
    grace_days: policy.orphanGraceDays,
    session_dir: scan.session_dir,
    total_files: scan.total_files,
    scanned_files: scan.scanned_files,
    truncated: scan.truncated,
    scanned_path_files: scan.scanned_path_files,
    scanned_jsonl_files: scan.scanned_jsonl_files,
    dangling_path_files: scan.dangling_path_files.length,
    unmapped_jsonl_files: scan.unmapped_jsonl_files.length,
    unknown_files: scan.unknown_files.length,
    unsafe_path_files: unsafeFiles.length,
    safe_deletable_files: safeDeletableFiles.length,
    deleted_path_files: deleteResult.deleted_path_files,
    deleted_jsonl_files: deleteResult.deleted_jsonl_files,
    skipped_recent_files: skippedRecentFiles.length,
    skipped_unarchived_files: skippedUnarchivedFiles.length,
    skipped_unmapped_session_files: skippedUnmappedSessionFiles.length,
    samples: {
      dangling_path_files: sampleEntryNames(
        scan.dangling_path_files,
        sampleLimit,
      ),
      unmapped_jsonl_files: sampleEntryNames(
        scan.unmapped_jsonl_files,
        sampleLimit,
      ),
      unknown_files: sampleEntryNames(scan.unknown_files, sampleLimit),
      unsafe_path_files: sampleEntryNames(unsafeFiles, sampleLimit),
      safe_deletable_files: sampleEntryNames(safeDeletableFiles, sampleLimit),
      skipped_recent_files: sampleEntryNames(skippedRecentFiles, sampleLimit),
      skipped_unarchived_files: sampleEntryNames(
        skippedUnarchivedFiles,
        sampleLimit,
      ),
      skipped_unmapped_session_files: sampleEntryNames(
        skippedUnmappedSessionFiles,
        sampleLimit,
      ),
    },
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
      throw new Error('该手机号已存在', { cause: err });
    }
    throw err;
  }

  return { id: user.id };
}

/**
 * 管理员重置用户密码，并撤销旧登录态。
 *
 * @param input.userId 目标用户 ID。
 * @param input.password 新密码，至少 8 位。
 * @returns 更新后的用户 ID 和认证令牌版本。
 * @remarks 该能力不校验旧密码，必须只暴露给 owner 级后台密钥。
 */
export async function resetAdminUserPassword(input: {
  userId: string;
  password: string;
}): Promise<{ id: string; auth_token_version: number }> {
  if (input.password.length < ADMIN_CREATE_USER_PASSWORD_MIN_LENGTH) {
    throw new Error(`密码至少 ${ADMIN_CREATE_USER_PASSWORD_MIN_LENGTH} 位`);
  }
  const user = await getUserById(input.userId);
  if (!user) {
    throw new Error('用户不存在');
  }
  const updated = await updateUserPasswordHash(
    input.userId,
    await bcrypt.hash(input.password, ADMIN_CREATE_USER_SALT_ROUNDS),
  );
  return {
    id: updated.id,
    auth_token_version: updated.auth_token_version ?? 0,
  };
}

/**
 * 管理员设置用户会员套餐与有效期。
 *
 * @param input.userId 目标用户 ID。
 * @param input.planKey 会员套餐 key。
 * @param input.currentPeriodEnd 会员有效期结束时间。
 * @returns 最新会员状态、权益时间轴和可用套餐。
 * @remarks 正常用户购买不要调用此函数，它不会扣减积分余额。
 */
export async function setAdminUserMembership(input: {
  userId: string;
  planKey: string;
  currentPeriodEnd: string;
}): Promise<AdminUserMembershipState> {
  await setUserMembershipForAdmin({
    userId: input.userId,
    planKey: input.planKey,
    currentPeriodEnd: input.currentPeriodEnd,
  });
  return getAdminUserMembershipState(input.userId);
}

/**
 * 管理员停用用户全部有效会员周期。
 *
 * @param userId 目标用户 ID。
 * @returns 最新会员状态、权益时间轴和可用套餐。
 * @remarks 会保留历史会员与额度记录，只让当前权益立即失效。
 */
export async function cancelAdminUserMembership(
  userId: string,
): Promise<AdminUserMembershipState> {
  await cancelUserMembershipsForAdmin(userId);
  return getAdminUserMembershipState(userId);
}

/**
 * 聚合用户列表页需要的统计信息。
 */
export async function listAdminUsersWithStats(
  options: AdminUserListOptions = {},
): Promise<AdminUsersPageResult> {
  const page = Math.max(1, Math.trunc(options.page ?? 1));
  const pageSize = Math.min(
    ADMIN_USERS_MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(options.pageSize ?? ADMIN_USERS_DEFAULT_PAGE_SIZE)),
  );
  const { users, total } = await listUsersPageForAdmin({
    limit: pageSize,
    offset: (page - 1) * pageSize,
    query: options.query,
  });
  const userIds = users.map((user) => user.id);
  const [accountCounts, usageStats, monthlyBillings, memberships] =
    await Promise.all([
      getAccountCountsByOwnerIds(userIds),
      getUsageStatsByUserIds(userIds),
      getMonthlyMeteredBillingSummariesByUserIds(userIds),
      getMembershipBillingSummariesByUserIds(userIds),
    ]);

  return {
    items: users.map(({ password_hash: _passwordHash, ...safe }) => {
      const monthlyBilling = monthlyBillings.get(safe.id) ?? {
        usedTokens: 0,
        chargedCoins: 0,
      };
      return {
        ...safe,
        account_count: accountCounts.get(safe.id) ?? 0,
        usage:
          usageStats.get(safe.id) ??
          ({
            total_messages: 0,
            total_input_tokens: 0,
            total_output_tokens: 0,
            total_tokens: 0,
            monthly_messages: 0,
            today_messages: 0,
            today_input_tokens: 0,
            today_output_tokens: 0,
            today_total_tokens: 0,
          } satisfies Awaited<ReturnType<typeof getUsageStats>>),
        monthly_tokens_used: monthlyBilling.usedTokens,
        estimated_monthly_total_coins: monthlyBilling.chargedCoins,
        purchased_coins: safe.purchased_coins,
        bonus_coins: safe.bonus_coins,
        reserved_coins: safe.reserved_coins,
        available_coins: safe.purchased_coins + safe.bonus_coins,
        membership: membershipStatusToAdminView(
          memberships.get(safe.id) ??
            ({
              enabled: false,
              active: false,
              planKey: null,
              monthlyPriceCoins: 0,
              displayPriceCoins: 0,
              currentPeriodStart: null,
              currentPeriodEnd: null,
              allowanceResetAt: null,
              allowanceUsedRatio: 0,
              allowanceStatus: 'inactive',
            } satisfies Awaited<
              ReturnType<typeof getMembershipBillingSummary>
            >),
        ),
      };
    }),
    total,
    page,
    page_size: pageSize,
  };
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
    usage: Awaited<ReturnType<typeof getUsageStats>>;
    monthly_tokens_used: number;
    estimated_monthly_total_coins: number;
    purchased_coins: number;
    bonus_coins: number;
    reserved_coins: number;
    available_coins: number;
    membership: MembershipStatusDto;
  };
  accounts: Array<Record<string, unknown>>;
  usage: Awaited<ReturnType<typeof getUsageStats>>;
  membership: MembershipStatusDto;
  membership_entitlements: MembershipEntitlementDto[];
  membership_plans: MembershipPlanDto[];
} | null> {
  const user = await getUserById(userId);
  if (!user) {
    return null;
  }

  const { password_hash: _passwordHash, ...safe } = user;
  const [accounts, usage, monthlyBilling, wallet, membershipState] =
    await Promise.all([
      getAccountsByUserId(userId),
      getUsageStats(userId),
      getMonthlyMeteredBillingSummary(userId),
      getWalletBalanceSummary(userId),
      getAdminUserMembershipState(userId),
    ]);

  return {
    user: {
      ...safe,
      account_count: accounts.length,
      usage,
      monthly_tokens_used: monthlyBilling.usedTokens,
      estimated_monthly_total_coins: monthlyBilling.chargedCoins,
      purchased_coins: wallet.purchasedCoins,
      bonus_coins: wallet.bonusCoins,
      reserved_coins: wallet.reservedCoins,
      available_coins: wallet.availableCoins,
      membership: membershipState.membership,
    },
    accounts: accounts.map(({ bot_token: _botToken, ...rest }) => rest),
    usage,
    ...membershipState,
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
