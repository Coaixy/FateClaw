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
  phone: string;
  phone_verified: boolean;
  role: 'consumer' | 'creator' | 'both' | 'admin';
  created_at: string;
  account_count: number;
  active_tasks: number;
  usage: UsageStats;
  monthly_tokens_used: number;
  estimated_monthly_total_cents: number;
  purchased_cents: number;
  bonus_cents: number;
  earned_cents: number;
  reserved_cents: number;
  available_cents: number;
}

export interface WalletTransaction {
  id: string;
  user_id: string;
  kind: string;
  amount_cents: number;
  reserved_delta_cents: number;
  balance_source: 'purchased' | 'bonus' | 'earned' | 'mixed' | null;
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
  today_messages: number;
  today_input_tokens: number;
  today_output_tokens: number;
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
  total_recharge_cents: number;
  total_recharge_yuan: string;
}

export interface UserDetail {
  user: AdminUser;
  accounts: AdminAccount[];
  usage: UsageStats;
  active_tasks: number;
}

export interface GlobalStats {
  total_users: number;
  model_selection_distribution: { source: string; count: number }[];
  active_subscriptions: number;
  total_recharge_orders: number;
  paid_recharge_orders: number;
  pending_recharge_orders: number;
  total_recharge_cents: number;
  total_recharge_yuan: string;
  today_recharge_cents: number;
  today_recharge_yuan: string;
  total_accounts: number;
  enabled_accounts: number;
  total_messages: number;
  total_input_tokens: number;
  total_output_tokens: number;
  today_messages: number;
  today_input_tokens: number;
  today_output_tokens: number;
  active_tasks: number;
  recent_signups_7d: number;
  recharge_period: AdminRechargePeriodStats;
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
}

export interface AdminChatSessionsResponse {
  sessions: AdminChatSession[];
  total: number;
}

export interface AdminTask {
  id: string;
  account_id: string;
  account_name: string;
  owner_phone: string | null;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  reminder_type: string | null;
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: string;
  created_at: string;
}

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
  input_token_price_per_million_cents: number;
  output_token_price_per_million_cents: number;
  extra_json: Record<string, unknown> | null;
  has_secret: boolean;
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
  min_yuan: string;
  max_yuan: string;
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

export interface AdminSystemConfigOverview {
  providers: AdminModelProvider[];
  official_models: AdminModelProvider[];
  runtime: null;
  audit_logs: AdminConfigAuditLog[];
}

export const admin = {
  verify: () =>
    adminRequest<{ success: boolean }>('/api/admin/verify', {
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
  systemConfig: () =>
    adminRequest<AdminSystemConfigOverview>('/api/admin/system-config'),
  rechargeConfig: () =>
    adminRequest<AdminRechargePaymentConfig>('/api/admin/recharge-config'),
  updateRechargeConfig: (data: AdminRechargePaymentConfigUpdate) =>
    adminRequest<AdminRechargePaymentConfig>('/api/admin/recharge-config', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
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
    input_token_price_per_million_cents: number;
    output_token_price_per_million_cents: number;
    api_key?: string;
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
      input_token_price_per_million_cents: number;
      output_token_price_per_million_cents: number;
    },
  ) =>
    adminRequest<AdminModelProvider>(
      `/api/admin/system-config/providers/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(data),
      },
    ),
  setOfficialModelSecret: (
    id: string,
    data: {
      api_key: string;
    },
  ) =>
    adminRequest<{ success: boolean }>(
      `/api/admin/system-config/providers/${encodeURIComponent(id)}/secret`,
      {
        method: 'POST',
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
  users: () => adminRequest<AdminUser[]>('/api/admin/users'),
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
  adjustPurchasedBalance: (
    id: string,
    data: { amount_cents: number; note?: string },
  ) =>
    adminRequest<{
      success: boolean;
      purchased_cents: number;
      bonus_cents: number;
      earned_cents: number;
      reserved_cents: number;
      available_cents: number;
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
  tasks: (opts?: { user_id?: string; status?: string }) => {
    const params = new URLSearchParams();
    if (opts?.user_id) params.set('user_id', opts.user_id);
    if (opts?.status) params.set('status', opts.status);
    const qs = params.toString();
    return adminRequest<AdminTask[]>(`/api/admin/tasks${qs ? `?${qs}` : ''}`);
  },
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
      amount_cents: number;
      source?: 'new_user_gift' | 'sign_in' | 'admin_grant' | 'promotion';
      note?: string;
      expires_at?: string | null;
    },
  ) =>
    adminRequest<{
      success: boolean;
      grant_id: string;
      bonus_cents: number;
    }>(`/api/admin/users/${encodeURIComponent(id)}/balance/grant`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  listWithdrawals: (opts?: {
    status?: 'pending' | 'approved' | 'rejected' | 'paid' | 'cancelled';
    creator_id?: string;
    limit?: number;
  }) => {
    const params = new URLSearchParams();
    if (opts?.status) params.set('status', opts.status);
    if (opts?.creator_id) params.set('creator_id', opts.creator_id);
    if (opts?.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return adminRequest<AdminWithdrawal[]>(
      `/api/admin/withdrawals${qs ? `?${qs}` : ''}`,
    );
  },
  approveWithdrawal: (
    id: string,
    data?: {
      tax_amount_yuan?: string;
      net_amount_yuan?: string;
      platform_fee_cents?: number;
      note?: string;
    },
  ) =>
    adminRequest<{ success: boolean }>(
      `/api/admin/withdrawals/${encodeURIComponent(id)}/approve`,
      { method: 'POST', body: JSON.stringify(data ?? {}) },
    ),
  rejectWithdrawal: (id: string, data: { note: string }) =>
    adminRequest<{ success: boolean }>(
      `/api/admin/withdrawals/${encodeURIComponent(id)}/reject`,
      { method: 'POST', body: JSON.stringify(data) },
    ),
  markWithdrawalPaid: (id: string, data: { payment_proof: string }) =>
    adminRequest<{ success: boolean }>(
      `/api/admin/withdrawals/${encodeURIComponent(id)}/mark-paid`,
      { method: 'POST', body: JSON.stringify(data) },
    ),
};

export interface AdminWithdrawal {
  id: string;
  creator_id: string;
  amount_cents: number;
  amount_yuan: string;
  status: 'pending' | 'approved' | 'rejected' | 'paid' | 'cancelled';
  bank_name: string | null;
  bank_account: string | null;
  account_name: string | null;
  id_number_masked: string | null;
  tax_type: 'personal' | 'company' | null;
  company_name: string | null;
  tax_id: string | null;
  platform_fee_cents: number;
  tax_amount_yuan: string;
  net_amount_yuan: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  paid_at: string | null;
  payment_proof: string | null;
  created_at: string;
}

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
 * 结构化 trace 事件。agent-runner 的 traceEvent() 写入这些条目，
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
