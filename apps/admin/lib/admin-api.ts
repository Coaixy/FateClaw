import type {
  SimpleModelPolicyDto,
  SimpleWorkflowPresetDto,
} from '@fateclaw/contracts/chat';
import type {
  AdminCreateGiftCodesResponseDto,
  AdminGiftCodesResponseDto,
  AdminStatusStatsDto,
  GiftCodeBalanceTypeDto,
  GiftCodeDto,
  GiftCodeStatusDto,
  GiftCodeUsageTypeDto,
  MembershipEntitlementDto,
  MembershipPlanDto,
  MembershipStatusDto,
} from '@fateclaw/contracts/billing';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || '';
const ADMIN_KEY_STORAGE_KEY = 'admin_key';
const DEFAULT_SERVER_ERROR_MESSAGE = '服务暂时不可用，请稍后重试';
const DEFAULT_NETWORK_ERROR_MESSAGE = '网络连接失败，请检查服务是否正常后重试';
const DEFAULT_INVALID_RESPONSE_MESSAGE = '服务返回异常，请稍后重试';

class AdminApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function readAdminKeyFrom(storage?: Storage | null): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(ADMIN_KEY_STORAGE_KEY);
  } catch (error) {
    if (error instanceof DOMException) return null;
    throw error;
  }
}

function writeAdminKeyTo(storage: Storage | null | undefined, key: string) {
  if (!storage) return;
  try {
    storage.setItem(ADMIN_KEY_STORAGE_KEY, key);
  } catch (error) {
    if (error instanceof DOMException) return;
    throw error;
  }
}

function removeAdminKeyFrom(storage?: Storage | null) {
  if (!storage) return;
  try {
    storage.removeItem(ADMIN_KEY_STORAGE_KEY);
  } catch (error) {
    if (error instanceof DOMException) return;
    throw error;
  }
}

export function getAdminKey(): string | null {
  if (typeof window === 'undefined') return null;
  return (
    readAdminKeyFrom(window.sessionStorage) ??
    readAdminKeyFrom(window.localStorage)
  );
}

export function hasPersistentAdminKey(): boolean {
  if (typeof window === 'undefined') return false;
  return readAdminKeyFrom(window.localStorage) !== null;
}

export function setAdminKey(key: string, persist = false) {
  if (typeof window === 'undefined') return;
  removeAdminKeyFrom(window.sessionStorage);
  removeAdminKeyFrom(window.localStorage);
  writeAdminKeyTo(persist ? window.localStorage : window.sessionStorage, key);
}

export function clearAdminKey() {
  if (typeof window === 'undefined') return;
  removeAdminKeyFrom(window.sessionStorage);
  removeAdminKeyFrom(window.localStorage);
}

export function isAdminUnauthorizedError(
  error: unknown,
): error is AdminApiError {
  return error instanceof AdminApiError && error.status === 401;
}

export function isAdminForbiddenError(error: unknown): error is AdminApiError {
  return error instanceof AdminApiError && error.status === 403;
}

export type AdminRole = 'owner' | 'user_manager';
export type AdminScope = 'admin:*' | 'users:*' | 'messages:*';
export type AdminHomePath =
  | '/admin/overview'
  | '/admin/users'
  | '/overview'
  | '/users';

export interface AdminSession {
  success: boolean;
  role: AdminRole;
  scopes: AdminScope[];
  home_path: AdminHomePath;
}

/** 管理后台完整运行状态统计。 */
export type AdminStatusStats = AdminStatusStatsDto;

async function adminRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const key = getAdminKey();

  const headers: Record<string, string> = {
    ...((options.headers as Record<string, string>) || {}),
  };

  if (options.body) {
    headers['Content-Type'] = 'application/json';
  }

  if (key) {
    headers['X-Admin-Key'] = key;
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
    });
  } catch {
    throw new AdminApiError(0, DEFAULT_NETWORK_ERROR_MESSAGE);
  }

  // 检测非 JSON 响应（后端未运行或返回了 HTML 页面）
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new AdminApiError(
      res.status,
      res.ok
        ? DEFAULT_INVALID_RESPONSE_MESSAGE
        : res.status >= 500
          ? DEFAULT_SERVER_ERROR_MESSAGE
          : '后端接口返回了非 JSON 响应，请确认服务是否正常运行',
    );
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new AdminApiError(
      res.status,
      res.status >= 500
        ? DEFAULT_SERVER_ERROR_MESSAGE
        : body.error || `请求失败 (${res.status})`,
    );
  }

  return res.json() as Promise<T>;
}

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
  /** @deprecated 使用 monthly_charged_coins。 */
  estimated_monthly_total_coins: number;
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
  | 'today'
  | '7d'
  | '30d'
  | 'month'
  | 'custom'
  | 'all';

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
  model_selection_distribution: { source: string; count: number }[];
  active_memberships: number;
  /** @deprecated 使用 active_memberships。 */
  active_subscriptions: number;
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
  user_id: string;
  user_phone: string | null;
  trade_id: string;
  provider: string;
  provider_trade_id: string | null;
  pay_type: AdminRechargePayType;
  amount_coins: number;
  pay_url: string | null;
  status: AdminRechargeOrderStatus;
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

/** 管理后台全局余额流水行。 */
export interface AdminWalletTransaction extends WalletTransaction {
  user_phone: string | null;
}

/** 管理后台全局余额流水列表响应。 */
export interface AdminWalletTransactionsResponse {
  transactions: AdminWalletTransaction[];
  total: number;
}

export type AdminGiftCodeBalanceType = GiftCodeBalanceTypeDto;
export type AdminGiftCodeUsageType = GiftCodeUsageTypeDto;
export type AdminGiftCodeStatus = GiftCodeStatusDto;
export type AdminGiftCode = GiftCodeDto;
export type AdminGiftCodesResponse = AdminGiftCodesResponseDto;
export type AdminCreateGiftCodesResponse = AdminCreateGiftCodesResponseDto;

export interface AdminCreateGiftCodesPayload {
  name?: string;
  balance_type: AdminGiftCodeBalanceType;
  usage_type: AdminGiftCodeUsageType;
  amount_coins: number;
  max_redemptions?: number;
  quantity: number;
  expires_at?: string | null;
  note?: string;
  code_prefix?: string;
  code?: string;
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

export interface AdminTextSkillBundleFile {
  path: string;
  content: string;
}

export interface AdminCustomSkill {
  id: string;
  user_id: string;
  phone: string | null;
  skill_name: string;
  description: string;
  bundle_uri: string;
  checksum: string | null;
  install_status: 'installed' | 'missing' | 'error';
  files: AdminTextSkillBundleFile[];
  content_length: number;
  visibility: 'private' | 'link_shared' | 'shared';
  share_token: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export type AdminModelPiApi =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai';

export interface AdminModelProvider {
  id: string;
  model_key: string;
  pi_api: AdminModelPiApi;
  display_name: string;
  description: string;
  enabled: boolean;
  priority: number;
  base_url: string | null;
  model_name: string;
  context_window_tokens: number | null;
  api_key_secret_key: string | null;
  input_token_price_per_million_coins: number;
  output_token_price_per_million_coins: number;
  extra_json: Record<string, unknown> | null;
  has_secret: boolean;
  api_key: string | null;
  secret_source: 'database' | 'missing';
  auth_mode:
    | 'openai_api_key'
    | 'anthropic_api_key'
    | 'claude_code_oauth_token'
    | 'gemini_api_key';
  created_at: string;
  updated_at: string;
}

export interface AdminConfigAuditLog {
  id: string;
  actor_user_id: string | null;
  action: string;
  target_type: string;
  target_key: string;
  before_json: unknown;
  after_json: unknown;
  created_at: string;
}

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

export interface AdminRewardConfig {
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

/** 管理后台邀请奖励状态。 */
export type AdminReferralRewardStatus =
  | 'pending'
  | 'granted'
  | 'skipped'
  | 'ineligible';

/** 管理后台邀请返会员配置。 */
export interface AdminReferralConfig {
  enabled: boolean;
  reward_membership_plan_key: string;
  inviter_reward_days: number;
  monthly_reward_cap_days: number;
  reward_first_membership_only: boolean;
  invite_count_reward_threshold: number;
  invite_count_reward_days: number;
  invite_count_reward_max_invites: number;
  updated_at: string;
}

/** 管理后台邀请关系列表行。 */
export interface AdminReferralRow {
  id: string;
  invite_code: string;
  inviter_id: string;
  inviter_phone: string | null;
  invitee_id: string;
  invitee_phone: string | null;
  bind_source: 'register' | 'redeem';
  reward_status: AdminReferralRewardStatus;
  reward_days: number;
  reward_event_id: string | null;
  rewarded_at: string | null;
  skip_reason: string | null;
  created_at: string;
}

/** 管理后台邀请关系列表响应。 */
export interface AdminReferralListResponse {
  referrals: AdminReferralRow[];
  total: number;
}

/** 关于页面公开收支流水类型。 */
export type AdminAboutLedgerEntryType = 'income' | 'expense';

/** 关于页面公开收支流水记录。 */
export interface AdminAboutLedgerEntry {
  id: string;
  entry_type: AdminAboutLedgerEntryType;
  occurred_at: string;
  content: string;
  amount_yuan: number;
  created_at: string;
  updated_at: string;
}

/** 关于页面公开收支流水列表响应。 */
export interface AdminAboutLedgerResponse {
  entries: AdminAboutLedgerEntry[];
}

/** 关于页面公开收支流水写入数据。 */
export type AdminAboutLedgerEntryDraft = Pick<
  AdminAboutLedgerEntry,
  'entry_type' | 'occurred_at' | 'content' | 'amount_yuan'
>;

/** 管理后台公告状态。 */
export type AdminAnnouncementStatus = 'draft' | 'published' | 'archived';

/** 管理后台公告记录。 */
export interface AdminAnnouncement {
  id: string;
  slug: string;
  title: string;
  summary: string;
  body_markdown: string;
  status: AdminAnnouncementStatus;
  priority: number;
  starts_at: string | null;
  ends_at: string | null;
  cta_label: string | null;
  cta_href: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 管理后台公告列表响应。 */
export interface AdminAnnouncementsResponse {
  announcements: AdminAnnouncement[];
}

/** 管理后台公告写入数据。 */
export type AdminAnnouncementDraft = Pick<
  AdminAnnouncement,
  | 'title'
  | 'summary'
  | 'body_markdown'
  | 'status'
  | 'priority'
  | 'starts_at'
  | 'ends_at'
  | 'cta_label'
  | 'cta_href'
>;

/** 管理后台公告更新数据。 */
export type AdminAnnouncementUpdate = Partial<AdminAnnouncementDraft>;

/** 后台模型计费配置视图，单位是软妹币 / 百万 Token。 */
export interface AdminModelBillingConfig {
  custom_model_platform_price_per_million_coins: number;
  updated_at: string;
}

export interface AdminRuntimeConfig {
  agent_concurrency_limit: number;
  local_agent_max_processes: number;
  local_agent_idle_ttl_ms: number;
  default_official_model_id: string | null;
  default_thinking_level:
    | 'off'
    | 'minimal'
    | 'low'
    | 'medium'
    | 'high'
    | 'xhigh';
  pi_session_health_enabled: boolean;
  pi_session_inactive_cleanup_days: number;
  pi_session_orphan_grace_days: number;
  skill_bundle_max_files: number;
  skill_bundle_max_file_chars: number;
  skill_bundle_max_total_chars: number;
  skill_bundle_max_zip_bytes: number;
  updated_at: string;
}

export type AdminSimpleWorkflowPreset = SimpleWorkflowPresetDto;

export interface AdminSimpleWorkflowPresetListResponse {
  presets: AdminSimpleWorkflowPreset[];
}

export interface AdminSimpleWorkflowPresetUpdate {
  name?: string;
  enabled?: boolean;
  is_default?: boolean;
  entry_title?: string;
  entry_description?: string;
  paipan_input_defaults?: Record<string, unknown>;
  model_policy?: SimpleModelPolicyDto;
  skill_ids?: string[];
  prompt_template?: string;
  sort_order?: number;
}

export interface AdminWorkflowSkillSummary {
  id: string;
  user_id: string;
  owner_phone: string | null;
  skill_name: string;
  dir_name: string;
  description: string;
  visibility: 'private' | 'link_shared' | 'shared';
  created_at: string;
  updated_at: string;
}

export interface AdminSimpleWorkflowResourcesResponse {
  skills: AdminWorkflowSkillSummary[];
}

/**
 * 管理后台提交的充值配置；支付回调地址由后端生成。
 */
export type AdminRechargePaymentConfigUpdate = Omit<
  AdminRechargePaymentConfig,
  'notify_url' | 'return_url' | 'updated_at'
>;

export interface AdminSystemConfigOverview {
  providers: AdminModelProvider[];
  official_models: AdminModelProvider[];
  model_billing: AdminModelBillingConfig;
  runtime: AdminRuntimeConfig;
  audit_logs: AdminConfigAuditLog[];
}

export const admin = {
  verify: () =>
    adminRequest<AdminSession>('/api/admin/verify', {
      method: 'POST',
    }),
  stats: (options?: {
    rechargeRange?: AdminRechargeStatsRange;
    rechargeStartDate?: string;
    rechargeEndDate?: string;
  }) => {
    const params = new URLSearchParams();
    if (options?.rechargeRange) {
      params.set('recharge_range', options.rechargeRange);
    }
    if (options?.rechargeStartDate) {
      params.set('recharge_start_date', options.rechargeStartDate);
    }
    if (options?.rechargeEndDate) {
      params.set('recharge_end_date', options.rechargeEndDate);
    }
    const query = params.toString();
    return adminRequest<GlobalStats>(
      `/api/admin/stats${query ? `?${query}` : ''}`,
    );
  },
  status: () => adminRequest<AdminStatusStats>('/api/admin/status'),
  rechargeOrders: (opts?: {
    user_id?: string;
    status?: AdminRechargeOrderStatus;
    pay_type?: AdminRechargePayType;
    limit?: number;
    offset?: number;
  }) => {
    const params = new URLSearchParams();
    if (opts?.user_id) params.set('user_id', opts.user_id);
    if (opts?.status) params.set('status', opts.status);
    if (opts?.pay_type) params.set('pay_type', opts.pay_type);
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.offset) params.set('offset', String(opts.offset));
    const query = params.toString();
    return adminRequest<AdminRechargeOrdersResponse>(
      `/api/admin/billing/recharge-orders${query ? `?${query}` : ''}`,
    );
  },
  walletTransactions: (opts?: {
    user_id?: string;
    kind?: string;
    limit?: number;
    offset?: number;
  }) => {
    const params = new URLSearchParams();
    if (opts?.user_id) params.set('user_id', opts.user_id);
    if (opts?.kind) params.set('kind', opts.kind);
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.offset) params.set('offset', String(opts.offset));
    const query = params.toString();
    return adminRequest<AdminWalletTransactionsResponse>(
      `/api/admin/billing/wallet-transactions${query ? `?${query}` : ''}`,
    );
  },
  giftCodes: (opts?: {
    status?: AdminGiftCodeStatus;
    balance_type?: AdminGiftCodeBalanceType;
    limit?: number;
    offset?: number;
  }) => {
    const params = new URLSearchParams();
    if (opts?.status) params.set('status', opts.status);
    if (opts?.balance_type) params.set('balance_type', opts.balance_type);
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.offset) params.set('offset', String(opts.offset));
    const query = params.toString();
    return adminRequest<AdminGiftCodesResponse>(
      `/api/admin/billing/gift-codes${query ? `?${query}` : ''}`,
    );
  },
  createGiftCodes: (data: AdminCreateGiftCodesPayload) =>
    adminRequest<AdminCreateGiftCodesResponse>(
      '/api/admin/billing/gift-codes',
      {
        method: 'POST',
        body: JSON.stringify(data),
      },
    ),
  billingReservations: (opts?: {
    user_id?: string;
    hold_state?: AdminBillingHoldState;
    charge_state?: AdminBillingChargeState;
    limit?: number;
    offset?: number;
  }) => {
    const params = new URLSearchParams();
    params.set('include_total', 'true');
    if (opts?.user_id) params.set('user_id', opts.user_id);
    if (opts?.hold_state) params.set('hold_state', opts.hold_state);
    if (opts?.charge_state) params.set('charge_state', opts.charge_state);
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.offset) params.set('offset', String(opts.offset));
    const query = params.toString();
    return adminRequest<AdminBillingReservationsResponse>(
      `/api/admin/billing/reservations${query ? `?${query}` : ''}`,
    );
  },
  systemConfig: () =>
    adminRequest<AdminSystemConfigOverview>('/api/admin/system-config'),
  rechargeConfig: () =>
    adminRequest<AdminRechargePaymentConfig>('/api/admin/recharge-config'),
  updateRechargeConfig: (data: AdminRechargePaymentConfigUpdate) =>
    adminRequest<AdminRechargePaymentConfig>('/api/admin/recharge-config', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  rewardConfig: () =>
    adminRequest<AdminRewardConfig>('/api/admin/reward-config'),
  updateRewardConfig: (data: {
    daily_sign_in: {
      enabled: boolean;
      reward_coins: number;
    };
    membership: {
      enabled: boolean;
      monthly_price_coins: number;
      monthly_allowance_units: number;
      standard_price_per_million_units_coins: number;
    };
    membership_plans?: Array<{
      plan_key: string;
      name: string;
      enabled: boolean;
      monthly_price_coins: number;
      display_price_coins: number;
      monthly_allowance_units: number;
      standard_price_per_million_units_coins: number;
    }>;
    free_professional_ai?: {
      daily_turn_limit: number;
    };
  }) =>
    adminRequest<AdminRewardConfig>('/api/admin/reward-config', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  referralConfig: () =>
    adminRequest<AdminReferralConfig>('/api/admin/referrals/config'),
  updateReferralConfig: (data: {
    enabled: boolean;
    reward_membership_plan_key: string;
    inviter_reward_days: number;
    monthly_reward_cap_days: number;
    reward_first_membership_only?: boolean;
    invite_count_reward_threshold?: number;
    invite_count_reward_days?: number;
    invite_count_reward_max_invites?: number;
  }) =>
    adminRequest<AdminReferralConfig>('/api/admin/referrals/config', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  referrals: (opts?: {
    inviter_id?: string;
    invitee_id?: string;
    reward_status?: AdminReferralRewardStatus;
    limit?: number;
    offset?: number;
  }) => {
    const params = new URLSearchParams();
    if (opts?.inviter_id) params.set('inviter_id', opts.inviter_id);
    if (opts?.invitee_id) params.set('invitee_id', opts.invitee_id);
    if (opts?.reward_status) params.set('reward_status', opts.reward_status);
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.offset) params.set('offset', String(opts.offset));
    const query = params.toString();
    return adminRequest<AdminReferralListResponse>(
      `/api/admin/referrals${query ? `?${query}` : ''}`,
    );
  },
  aboutLedger: () =>
    adminRequest<AdminAboutLedgerResponse>('/api/admin/about-ledger'),
  createAboutLedgerEntry: (data: AdminAboutLedgerEntryDraft) =>
    adminRequest<AdminAboutLedgerEntry>('/api/admin/about-ledger', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateAboutLedgerEntry: (id: string, data: AdminAboutLedgerEntryDraft) =>
    adminRequest<AdminAboutLedgerEntry>(
      `/api/admin/about-ledger/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(data),
      },
    ),
  deleteAboutLedgerEntry: (id: string) =>
    adminRequest<{ success: boolean }>(
      `/api/admin/about-ledger/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
  announcements: () =>
    adminRequest<AdminAnnouncementsResponse>('/api/admin/announcements'),
  createAnnouncement: (data: AdminAnnouncementDraft) =>
    adminRequest<AdminAnnouncement>('/api/admin/announcements', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateAnnouncement: (id: string, data: AdminAnnouncementUpdate) =>
    adminRequest<AdminAnnouncement>(
      `/api/admin/announcements/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(data),
      },
    ),
  deleteAnnouncement: (id: string) =>
    adminRequest<{ success: boolean }>(
      `/api/admin/announcements/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
  updateModelBilling: (data: {
    custom_model_platform_price_per_million_coins: number;
  }) =>
    adminRequest<AdminModelBillingConfig>(
      '/api/admin/system-config/model-billing',
      {
        method: 'PUT',
        body: JSON.stringify(data),
      },
    ),
  updateRuntimeConfig: (data: {
    agent_concurrency_limit: number;
    local_agent_max_processes?: number;
    local_agent_idle_ttl_ms?: number;
    default_official_model_id?: string | null;
    default_thinking_level?: AdminRuntimeConfig['default_thinking_level'];
    pi_session_health_enabled?: boolean;
    pi_session_inactive_cleanup_days?: number;
    pi_session_orphan_grace_days?: number;
    skill_bundle_max_files?: number;
    skill_bundle_max_file_chars?: number;
    skill_bundle_max_total_chars?: number;
    skill_bundle_max_zip_bytes?: number;
  }) =>
    adminRequest<AdminRuntimeConfig>('/api/admin/system-config/runtime', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  simpleWorkflows: () =>
    adminRequest<AdminSimpleWorkflowPresetListResponse>(
      '/api/admin/simple-workflows',
    ),
  simpleWorkflowResources: () =>
    adminRequest<AdminSimpleWorkflowResourcesResponse>(
      '/api/admin/simple-workflows/resources',
    ),
  updateSimpleWorkflowPreset: (
    id: string,
    data: AdminSimpleWorkflowPresetUpdate,
    options?: Pick<RequestInit, 'signal'>,
  ) =>
    adminRequest<AdminSimpleWorkflowPreset>(
      `/api/admin/simple-workflows/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(data),
        signal: options?.signal,
      },
    ),
  createOfficialModel: (data: {
    model_key: string;
    pi_api: AdminModelPiApi;
    display_name: string;
    description?: string;
    enabled: boolean;
    priority: number;
    base_url?: string | null;
    model_name: string;
    context_window_tokens?: number | null;
    input_token_price_per_million_coins: number;
    output_token_price_per_million_coins: number;
    api_key: string;
  }) =>
    adminRequest<AdminModelProvider>('/api/admin/system-config/providers', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateOfficialModel: (
    id: string,
    data: {
      model_key: string;
      pi_api: AdminModelPiApi;
      display_name: string;
      description?: string;
      enabled: boolean;
      priority: number;
      base_url?: string | null;
      model_name: string;
      context_window_tokens?: number | null;
      input_token_price_per_million_coins: number;
      output_token_price_per_million_coins: number;
      api_key?: string;
    },
  ) =>
    adminRequest<AdminModelProvider>(
      `/api/admin/system-config/providers/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(data),
      },
    ),
  deleteOfficialModel: (id: string) =>
    adminRequest<{ success: boolean }>(
      `/api/admin/system-config/providers/${encodeURIComponent(id)}`,
      {
        method: 'DELETE',
      },
    ),
  users: (params?: { page?: number; page_size?: number; q?: string }) => {
    const search = new URLSearchParams();
    if (params?.page != null) search.set('page', String(params.page));
    if (params?.page_size != null)
      search.set('page_size', String(params.page_size));
    if (params?.q?.trim()) search.set('q', params.q.trim());
    const query = search.toString();
    return adminRequest<AdminUsersPageResult>(
      `/api/admin/users${query ? `?${query}` : ''}`,
    );
  },
  createUser: (data: {
    phone: string;
    password: string;
    role: AdminUser['role'];
    phone_verified: boolean;
  }) =>
    adminRequest<{ success: boolean; id: string }>('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  userDetail: (id: string) =>
    adminRequest<UserDetail>(`/api/admin/users/${encodeURIComponent(id)}`),
  resetUserPassword: (id: string, password: string) =>
    adminRequest<{ id: string; auth_token_version: number }>(
      `/api/admin/users/${encodeURIComponent(id)}/password`,
      {
        method: 'POST',
        body: JSON.stringify({ password }),
      },
    ),
  setUserMembership: (
    id: string,
    data: { plan_key: string; current_period_end: string },
  ) =>
    adminRequest<AdminMembershipState>(
      `/api/admin/users/${encodeURIComponent(id)}/membership`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      },
    ),
  cancelUserMembership: (id: string) =>
    adminRequest<AdminMembershipState>(
      `/api/admin/users/${encodeURIComponent(id)}/membership`,
      { method: 'DELETE' },
    ),
  adjustPurchasedBalance: (
    id: string,
    data: { amount_coins: number; note?: string },
  ) =>
    adminRequest<{
      success: boolean;
      purchased_coins: number;
      bonus_coins: number;
      reserved_coins: number;
      available_coins: number;
    }>(`/api/admin/users/${encodeURIComponent(id)}/balance/adjust`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  userTransactions: (id: string) =>
    adminRequest<WalletTransaction[]>(
      `/api/admin/users/${encodeURIComponent(id)}/transactions`,
    ),
  deleteUser: (id: string) =>
    adminRequest<{ success: boolean }>(
      `/api/admin/users/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
  messages: (opts?: {
    account_id?: string;
    user_id?: string;
    session_id?: string;
    limit?: number;
    offset?: number;
  }) => {
    const params = new URLSearchParams();
    if (opts?.account_id) params.set('account_id', opts.account_id);
    if (opts?.user_id) params.set('user_id', opts.user_id);
    if (opts?.session_id) params.set('session_id', opts.session_id);
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.offset) params.set('offset', String(opts.offset));
    const qs = params.toString();
    return adminRequest<AdminMessagesResponse>(
      `/api/admin/messages${qs ? `?${qs}` : ''}`,
    );
  },
  chatSessions: (opts?: {
    account_id?: string;
    user_id?: string;
    limit?: number;
    offset?: number;
  }) => {
    const params = new URLSearchParams();
    if (opts?.account_id) params.set('account_id', opts.account_id);
    if (opts?.user_id) params.set('user_id', opts.user_id);
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.offset) params.set('offset', String(opts.offset));
    const qs = params.toString();
    return adminRequest<AdminChatSessionsResponse>(
      `/api/admin/chat-sessions${qs ? `?${qs}` : ''}`,
    );
  },
  cleanupPiSessions: (data: {
    mode: 'soft_deleted' | 'inactive';
    inactive_days?: number;
  }) =>
    adminRequest<AdminPiSessionCleanupResult>(
      '/api/admin/chat-sessions/pi-sessions/cleanup',
      {
        method: 'POST',
        body: JSON.stringify(data),
      },
    ),
  scanPiSessionOrphans: (data: {
    action?: AdminPiSessionOrphanScanAction;
    limit?: number;
    sample_limit?: number;
  }) =>
    adminRequest<AdminPiSessionOrphanScanResult>(
      '/api/admin/chat-sessions/pi-sessions/orphans/scan',
      {
        method: 'POST',
        body: JSON.stringify(data),
      },
    ),
  globalSkills: () =>
    adminRequest<AdminSkillGlobalConfig[]>('/api/admin/skills/global'),
  setSkillGlobalEnabled: (name: string, enabled: boolean) =>
    adminRequest<{ success: boolean }>(
      `/api/admin/skills/global/${encodeURIComponent(name)}/${enabled ? 'enable' : 'disable'}`,
      { method: 'POST' },
    ),
  customSkills: (opts?: { user_id?: string }) => {
    const params = new URLSearchParams();
    if (opts?.user_id) params.set('user_id', opts.user_id);
    const qs = params.toString();
    return adminRequest<AdminCustomSkill[]>(
      `/api/admin/skills/custom${qs ? `?${qs}` : ''}`,
    );
  },
  customSkill: (id: string) =>
    adminRequest<AdminCustomSkill>(
      `/api/admin/skills/custom/${encodeURIComponent(id)}`,
    ),
  updateCustomSkillState: (
    id: string,
    data: {
      enabled?: boolean;
      visibility?: 'private' | 'link_shared' | 'shared';
    },
  ) =>
    adminRequest<AdminCustomSkill>(
      `/api/admin/skills/custom/${encodeURIComponent(id)}/state`,
      { method: 'PATCH', body: JSON.stringify(data) },
    ),
  grantBonusBalance: (
    id: string,
    data: {
      amount_coins: number;
      source?: 'new_user_gift' | 'sign_in' | 'admin_grant' | 'promotion';
      note?: string;
      expires_at?: string | null;
    },
  ) =>
    adminRequest<{
      success: boolean;
      grant_id: string;
      bonus_coins: number;
    }>(`/api/admin/users/${encodeURIComponent(id)}/balance/grant`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
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

export { AdminApiError };
