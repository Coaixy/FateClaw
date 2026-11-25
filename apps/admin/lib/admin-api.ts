import type {
  AdminModelSettingsOverviewDto,
  AdminModelSettingsUpdateDto,
} from '@fateclaw/contracts/model-settings';
import type {
  ChatSessionDto,
  ClientProfileDto,
  MessageDto,
} from '@fateclaw/contracts/chat';
import type {
  AdminSkillCommentDto,
  AdminCustomSkillDto,
  AdminCustomSkillSummaryDto,
  AdminSkillCommentsResponseDto,
  AdminSkillCommentStatusDto,
} from '@fateclaw/contracts/skills';
import type {
  AdminStatusStatsDto,
  MembershipEntitlementDto,
  MembershipPlanDto,
  MembershipStatusDto,
} from '@fateclaw/contracts/billing';

import { adminSystemApi } from './admin-system-api';
import { adminBillingApi } from './admin-billing-api';
import { adminUsersApi } from './admin-users-api';
import { adminConversationsApi } from './admin-conversations-api';
import { adminSkillsApi } from './admin-skills-api';
import { adminRequest } from './admin-http';
export {
  AdminApiError,
  adminRequest,
  getAdminKey,
  hasPersistentAdminKey,
  setAdminKey,
  clearAdminKey,
  isAdminUnauthorizedError,
  isAdminForbiddenError,
  formatAdminErrorMessage,
} from './admin-http';

export type AdminRole = 'owner' | 'user_manager';
export type AdminScope =
  'admin:*' | 'users:read' | 'users:create' | 'messages:read';
export type AdminHomePath = '/overview' | '/users';

export interface AdminSession {
  success: boolean;
  role: AdminRole;
  scopes: AdminScope[];
  home_path: AdminHomePath;
}

/** 管理后台完整运行状态统计。 */
export type AdminStatusStats = AdminStatusStatsDto;

export interface AdminUser {
  id: string;
  phone: string | null;
  phone_verified: boolean;
  role: 'consumer' | 'creator' | 'both' | 'admin';
  created_at: string;
  account_count: number;
  usage: UsageStats;
  membership: MembershipStatusDto;
  monthly_tokens_used: number;
  monthly_charged_coins: number;
  purchased_coins: number;
  bonus_coins: number;
  reserved_coins: number;
  available_coins: number;
}

export interface AdminUsersPageResult {
  items: AdminUser[];
  total: number;
  page: number;
  page_size: number;
}

export interface WalletTransaction {
  id: string;
  user_id: string;
  kind: string;
  amount_coins: number;
  reserved_delta_coins: number;
  balance_source: 'purchased' | 'bonus' | 'mixed' | null;
  balance_grant_id: string | null;
  request_id: string | null;
  note: string | null;
  metadata: unknown;
  created_at: string;
}

/** 管理后台赠送余额批次行。 */
export interface AdminBalanceGrant {
  id: string;
  user_id: string;
  source: string;
  granted_by: string | null;
  amount_coins: number;
  remaining_coins: number;
  note: string | null;
  expires_at: string | null;
  status: 'active' | 'exhausted' | 'expired' | 'revoked';
  created_at: string;
  updated_at: string;
}

export interface AdminAccount {
  id: string;
  user_id: string;
  name: string;
  base_url: string;
  enabled: boolean;
  created_at: string;
  owner_id: string | null;
}

export interface UsageStats {
  total_messages: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  monthly_messages: number;
  today_messages: number;
  today_input_tokens: number;
  today_output_tokens: number;
  today_total_tokens: number;
}

export type AdminRechargeStatsRange =
  'today' | '7d' | '30d' | 'month' | 'custom' | 'all';

export interface AdminRechargePeriodStats {
  range: AdminRechargeStatsRange;
  label: string;
  start_date: string | null;
  end_date: string | null;
  paid_orders: number;
  paid_users: number;
  total_recharge_coins: number;
}

export interface UserDetail {
  user: AdminUser;
  accounts: AdminAccount[];
  usage: UsageStats;
  membership: MembershipStatusDto;
  membership_entitlements: MembershipEntitlementDto[];
  membership_plans: MembershipPlanDto[];
}

export type AdminMembershipState = Pick<
  UserDetail,
  'membership' | 'membership_entitlements' | 'membership_plans'
>;

export interface GlobalStats {
  total_users: number;
  active_memberships: number;
  total_recharge_orders: number;
  paid_recharge_orders: number;
  pending_recharge_orders: number;
  failed_recharge_orders: number;
  paid_recharge_users: number;
  total_recharge_coins: number;
  today_recharge_coins: number;
  held_billing_reservations: number;
  pending_billing_reservations: number;
  total_purchased_coins: number;
  total_bonus_coins: number;
  total_reserved_coins: number;
  total_available_coins: number;
  negative_balance_users: number;
  total_accounts: number;
  enabled_accounts: number;
  total_messages: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  today_messages: number;
  today_input_tokens: number;
  today_output_tokens: number;
  today_total_tokens: number;
  recent_signups_7d: number;
  recharge_period: AdminRechargePeriodStats;
}

export type AdminRechargeOrderStatus = 'pending' | 'paid' | 'failed';
export type AdminRechargePayType = 'alipay' | 'wechat';

/** 管理后台充值订单行。 */
export interface AdminRechargeOrder {
  id: string;
  user_id: string | null;
  user_phone: string | null;
  trade_id: string;
  provider: string;
  provider_trade_id: string | null;
  pay_type: AdminRechargePayType;
  amount_coins: number;
  pay_url: string | null;
  status: AdminRechargeOrderStatus;
  credit_status: 'pending' | 'credited' | 'reconciliation_required';
  paid_at: string | null;
  notified_at: string | null;
  metadata: unknown;
  created_at: string;
  updated_at: string;
}

/** 管理后台充值订单列表响应。 */
export interface AdminRechargeOrdersResponse {
  orders: AdminRechargeOrder[];
  total: number;
}

export type AdminBillingHoldState = 'none' | 'held' | 'released';
export type AdminBillingChargeState = 'pending' | 'charged';

/** 管理后台请求级计费预约记录。 */
export interface AdminBillingRequestReservation {
  request_id: string;
  user_id: string;
  model_config_id: string | null;
  year_month: string;
  reserved_coins: number;
  hold_state: AdminBillingHoldState;
  charge_state: AdminBillingChargeState;
  actual_charge_coins: number;
  total_overage_tokens: number;
  total_overage_cost_coins: number;
  note: string | null;
  metadata: unknown;
  released_at: string | null;
  charged_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 管理后台请求级计费预约分页响应。 */
export interface AdminBillingReservationsResponse {
  reservations: AdminBillingRequestReservation[];
  total: number;
}

/** 手动修复陈旧计费预留后的摘要。 */
export interface AdminBillingReconcileResult {
  released: number;
  requestIds: string[];
}

/** 管理后台全局余额流水行。 */
export interface AdminWalletTransaction extends WalletTransaction {
  user_phone: string | null;
}

/** 管理后台全局余额流水列表响应。 */
export interface AdminWalletTransactionsResponse {
  transactions: AdminWalletTransaction[];
  total: number;
}

export interface AdminMessage {
  id: string;
  account_id: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message: boolean;
  session_id: string | null;
  session_title: string | null;
  deleted_at: string | null;
  session_deleted_at: string | null;
}

export interface AdminMessagesResponse {
  messages: AdminMessage[];
  total: number;
}

export interface AdminChatSession {
  id: string;
  account_id: string;
  account_name: string;
  owner_user_id: string | null;
  owner_phone: string | null;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  last_message_at: string | null;
  last_message_preview: string | null;
  deleted_at: string | null;
  pi_session_archived_at: string | null;
  pi_session_archive_reason: string | null;
}

export interface AdminChatSessionsResponse {
  sessions: AdminChatSession[];
  total: number;
}

/** 管理后台查看单条会话完整内容的响应（含消息列表与可选客户档案，复用用户侧 DTO）。 */
export interface AdminChatSessionDetailResponse {
  session: ChatSessionDto;
  messages: MessageDto[];
  client?: ClientProfileDto;
}

/** 管理后台会员套餐配置视图（复用 contracts 的 MembershipPlanDto，含已停用套餐）。 */
export type AdminMembershipPlanConfig = MembershipPlanDto;

/** 管理后台会员套餐配置列表响应。 */
export interface AdminMembershipConfigResponse {
  plans: AdminMembershipPlanConfig[];
}

/** 管理后台更新会员套餐配置请求体（字段均可选，至少传一个）。 */
export interface AdminMembershipConfigUpdate {
  monthly_price_coins?: number;
  display_price_coins?: number;
  name?: string;
  enabled?: boolean;
}

/** 管理后台 Pi session 文件清理结果。 */
export interface AdminPiSessionCleanupResult {
  success: boolean;
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

export interface AdminPiSessionOrphanScanResult {
  success: boolean;
  action: 'audit' | 'delete';
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

export type AdminPiSessionOrphanScanAction = 'audit' | 'delete';

export interface AdminSkillGlobalConfig {
  skill_name: string;
  globally_enabled: boolean;
  updated_at: string;
  updated_by: string | null;
  dir?: string;
}

export type AdminCustomSkill = AdminCustomSkillDto;
export type AdminCustomSkillSummary = AdminCustomSkillSummaryDto;

/** 管理后台 Skill 评论审核行。 */
export type AdminSkillComment = AdminSkillCommentDto;

/** 管理后台 Skill 评论审核状态。 */
export type AdminSkillCommentStatus = AdminSkillCommentStatusDto;

/** 管理后台 Skill 评论审核列表响应。 */
export interface AdminSkillCommentsResponse extends AdminSkillCommentsResponseDto {}

export interface AdminRechargePaymentConfig {
  enabled: boolean;
  min_coins: string;
  max_coins: string;
  epay_url_prefix: string;
  epay_platform_id: number | null;
  epay_merchant_private_key: string;
  epay_platform_public_key: string;
  epay_merchant_key: string;
  notify_url: string;
  return_url: string;
  updated_at: string;
}

/**
 * 管理后台提交的充值配置；支付回调地址由后端生成。
 */
export type AdminRechargePaymentConfigUpdate = Omit<
  AdminRechargePaymentConfig,
  'notify_url' | 'return_url' | 'updated_at'
>;

export type AdminSystemConfigOverview = AdminModelSettingsOverviewDto;
export type AdminModelSettingsUpdate = AdminModelSettingsUpdateDto;

/** 运行时基础设施状态快照（对应 GET /api/admin/runtime-status）。 */
export interface AdminRuntimeStatus {
  generatedAt: string;
  localAgents: Array<{
    accountId: string;
    busyCount: number;
    lastUsedAt: number;
    pid?: number;
    stopping: boolean;
    alive: boolean;
  }>;
  ipc: {
    listenerAccounts: string[];
    pinnedListenerCount: number;
    pendingInboxCount: number;
    pendingAiChatCount: number;
  };
  heartbeatAccounts: string[];
  queues: Array<{ key: string; depth: number }>;
  concurrency: {
    activeSlots: number;
    memberWaiters: number;
    normalWaiters: number;
  };
}

export const admin = {
  ...adminSystemApi,
  ...adminBillingApi,
  ...adminUsersApi,
  ...adminConversationsApi,
  ...adminSkillsApi,
};

// Conversation Logs (re-use types from user API)
export interface TranscriptEvent {
  type: 'assistant' | 'tool_use' | 'tool_result';
  text?: string;
  invocation?: {
    id: string;
    toolName: string;
    args: Record<string, unknown>;
  };
  invocationId?: string;
  ok?: boolean;
  output?: string;
  modelOutput?: string;
  artifactId?: string;
}

/**
 * 结构化 trace 事件。agent-runtime 的 traceEvent() 写入这些条目，
 * 在请求完成时随 ContainerOutput 一起回传，落库到 conversation_logs.trace_events。
 *
 * 18 种事件 type 的 schema 各不相同，此处用松类型，运行时由
 * TRACE_EVENT_META 根据 type 字段分派渲染。
 */
export type TraceEventEntry = Record<string, unknown> & {
  type: string;
  timestamp: string;
  requestId?: string;
  accountId?: string;
};

export interface AgentTaskNode {
  id: string;
  kind: 'root' | 'specialist';
  status: 'completed' | 'running' | 'blocked' | 'failed';
  source: 'supervisor' | 'runtime_guard';
  specialist?: string;
  goal: string;
  category?: string;
  startedAt: string;
  completedAt?: string;
  outputPreview?: string;
}

export interface AgentEvidenceNode {
  id: string;
  source: 'history' | 'artifact' | 'assistant_reply';
  category?: string;
  producer?: string;
  title: string;
  contentPreview: string;
  createdAt: string;
  artifactId?: string;
  payload?: unknown;
}

export interface AgentGraphEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  relation: 'uses' | 'delegates' | 'produces' | 'responds_with';
}

export interface AgentGraphSummary {
  category?: string;
  needsBoard: boolean;
  needsInterpretation: boolean;
  usedRuntimeGuards: boolean;
  specialistSequence: string[];
  taskCount: number;
  evidenceCount: number;
  finalTextPreview?: string;
}

export interface AgentTaskGraph {
  version: 1;
  requestId: string;
  accountId: string;
  sessionId?: string;
  rootTaskId: string;
  tasks: AgentTaskNode[];
  evidence: AgentEvidenceNode[];
  edges: AgentGraphEdge[];
  summary: AgentGraphSummary;
}

export interface ConversationLog {
  id: string;
  account_id: string;
  request_id: string;
  transcript: TranscriptEvent[];
  trace_events: TraceEventEntry[] | null;
  agent_graph: AgentTaskGraph | null;
  agent_graph_summary: AgentGraphSummary | null;
  capability_ledger: unknown | null;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null;
  model: string | null;
  provider: string | null;
  created_at: string;
}

/**
 * 列表场景的轻量版：不含 transcript / trace_events 正文，
 * 只有元数据 + 事件计数。admin logs 页的 LogCard 用这个渲染 header，
 * 展开时调 adminLogs.get(id) 懒加载完整 ConversationLog。
 */
export interface ConversationLogSummary {
  id: string;
  account_id: string;
  request_id: string;
  agent_graph_summary: AgentGraphSummary | null;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null;
  model: string | null;
  provider: string | null;
  created_at: string;
  tool_call_count: number;
  transcript_event_count: number;
  trace_event_count: number;
}

export const adminLogs = {
  list: (accountId: string, limit = 20, before?: string) => {
    const params = new URLSearchParams({ accountId, limit: String(limit) });
    if (before) params.set('before', before);
    return adminRequest<ConversationLogSummary[]>(
      `/api/admin/logs?${params.toString()}`,
    );
  },
  get: (logId: string) =>
    adminRequest<ConversationLog>(
      `/api/admin/logs/${encodeURIComponent(logId)}`,
    ),
  clearUser: (userId: string) =>
    adminRequest<{ success: boolean; deleted_count: number }>(
      `/api/admin/users/${encodeURIComponent(userId)}/logs`,
      { method: 'DELETE' },
    ),
  getByRequestId: (requestId: string) =>
    adminRequest<ConversationLog>(
      `/api/admin/logs/by-request/${encodeURIComponent(requestId)}`,
    ),
};
