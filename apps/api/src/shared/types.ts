// --- FateClaw Types ---

export type UserRole = 'consumer' | 'creator' | 'both' | 'admin';

export interface User {
  id: string;
  phone: string;
  phone_verified: boolean;
  password_hash: string;
  role: UserRole; // 'consumer'（默认） | 'creator' | 'both' | 'admin'
  purchased_points: number; // 充值积分（不过期，可消费）
  bonus_points: number; // 赠送积分（可过期，消费优先扣）
  earned_points: number; // 创作者收益（仅通过提现通道流出）
  reserved_points: number; // 请求级预扣
  pending_withdrawal_points: number; // 已申请提现中冻结的 earned_points
  created_at: string;
}

export type PointSource = 'purchased' | 'bonus' | 'earned' | 'mixed';

export type PointBatchSource =
  | 'new_user_gift'
  | 'sign_in'
  | 'admin_grant'
  | 'promotion';

export type PointBatchStatus = 'active' | 'exhausted' | 'expired' | 'revoked';

export interface PointBatch {
  id: string;
  user_id: string;
  source: PointBatchSource | string;
  granted_by: string | null;
  amount_points: number;
  remaining_points: number;
  note: string | null;
  expires_at: string | null;
  status: PointBatchStatus;
  created_at: string;
  updated_at: string;
}

export type WithdrawalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'paid'
  | 'cancelled';

export type WithdrawalTaxType = 'personal' | 'company';

export interface CreatorWithdrawal {
  id: string;
  creator_id: string;
  amount_points: number;
  amount_yuan: string; // NUMERIC -> string
  status: WithdrawalStatus;
  bank_name: string | null;
  bank_account: string | null;
  account_name: string | null;
  id_number: string | null; // AES-GCM 加密后 base64
  tax_type: WithdrawalTaxType | null;
  company_name: string | null;
  tax_id: string | null;
  platform_fee_points: number;
  tax_amount_yuan: string;
  net_amount_yuan: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  paid_at: string | null;
  payment_proof: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserSkill {
  user_id: string;
  skill_name: string;
  enabled: boolean;
  enabled_at: string;
}

export interface SkillPriceTier {
  key: string;
  label: string;
  price_points: number; // 积分定价（1 元 = 100 积分）
  duration_days: number | null;
  description?: string;
}

export interface TextSkillBundleFile {
  path: string;
  content: string;
}

export interface UserCustomSkill {
  id: string;
  user_id: string;
  skill_name: string;
  dir_name: string;
  description: string;
  version: string;
  bundle_uri: string;
  checksum: string | null;
  install_status: 'installed' | 'missing' | 'error';
  acl: Record<string, unknown>;
  billing_policy: Record<string, unknown>;
  audit_metadata: Record<string, unknown>;
  files: TextSkillBundleFile[];
  content_length: number;
  visibility: 'private' | 'link_shared' | 'shared';
  share_token: string | null;
  enabled: boolean;
  price_tiers: SkillPriceTier[];
  stat_subscriber_count: number;
  stat_view_count: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface UserSkillSubscription {
  id: string;
  subscriber_id: string;
  skill_id: string;
  has_direct_source: boolean;
  tier_key: string | null;
  status: 'active' | 'expired' | 'cancelled';
  enabled: boolean;
  expires_at: string | null;
  started_at: string;
  subscribed_at: string;
}

export interface SkillBundle {
  id: string;
  user_id: string;
  name: string;
  description: string;
  skill_ids: string[];
  bundle_token: string | null;
  visibility: 'private' | 'link_shared' | 'shared';
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface CreatorBundleTier {
  key: string;
  label: string;
  price_points: number;
  duration_days: number | null;
  description?: string;
}

export interface CreatorBundleSubscription {
  id: string;
  subscriber_id: string;
  creator_id: string;
  tier_key: string;
  status: 'active' | 'expired' | 'cancelled';
  expires_at: string | null;
  started_at: string;
}

/** IPC 同步到容器的用户 skill 条目（合并自有 + 订阅） */
export interface EffectiveUserSkill {
  id: string;
  dir: string;
  name: string;
  description: string;
  bundle_uri: string;
  checksum: string | null;
  install_status: 'installed' | 'missing' | 'error';
  visibility: 'private' | 'link_shared' | 'shared';
  source: 'self' | 'subscribed';
}

export interface Account {
  id: string; // bot_id, e.g. "xxx@im.bot"
  user_id: string; // wechat user id, e.g. "xxx@im.wechat"
  name: string; // display name, e.g. "老张"
  bot_token: string; // iLink bot token
  base_url: string; // iLink API base URL
  get_updates_buf: string; // iLink long-poll cursor
  enabled: boolean;
  created_at: string; // ISO timestamp
  owner_id: string | null; // references users.id
}

export interface CreatorEarningsMonthly {
  creator_id: string;
  year_month: string;
  gross_points: number;
  platform_cut_points: number;
  net_points: number;
  withdrawn_points: number;
  updated_at: string;
}

export interface NewMessage {
  id: string;
  /** 运行时会话键：微信场景为账号 ID，站内 AI Chat 为 web:{userId}。 */
  account_id: string;
  /** 站内 AI Chat 消息归属用户；微信消息可为空。 */
  user_id?: string | null;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  /** Skill 执行结果（JSON）。仅 AI 回复消息携带，用于跨请求保留 skill 原始数据。 */
  tool_context?: string | null;
  /** AI 对话会话 ID，null 表示微信消息。 */
  session_id?: string | null;
  /** 结构化元信息，供 AI chat 存储 progress 等非正文事件。 */
  metadata?: unknown;
}

export interface ChatSession {
  id: string;
  /** 站内 AI Chat 会话归属用户。 */
  user_id: string | null;
  /** 运行时会话键：微信场景为账号 ID，站内 AI Chat 为 web:{userId}。 */
  account_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export type ModelProviderType =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai';

export type UserModelSelectionSource = 'custom' | 'official';

export interface SystemSecretRow {
  key: string;
  secret_value: string;
  updated_by: string | null;
  updated_at: string;
}

export interface OfficialModelConfig {
  id: string;
  model_key: string;
  pi_api: ModelProviderType;
  display_name: string;
  enabled: boolean;
  priority: number;
  base_url: string | null;
  model_name: string;
  api_key_secret_key: string | null;
  input_token_price_per_million_points: number;
  output_token_price_per_million_points: number;
  extra_json: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface UserModelConfig {
  user_id: string;
  pi_api: ModelProviderType;
  base_url: string | null;
  model_name: string;
  api_key_secret_key: string | null;
  extra_json: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface UserModelSelection {
  user_id: string;
  source: UserModelSelectionSource;
  official_model_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConfigAuditLog {
  id: string;
  actor_user_id: string | null;
  action: string;
  target_type: string;
  target_key: string;
  before_json: unknown;
  after_json: unknown;
  created_at: string;
}

export interface ScheduledTask {
  id: string;
  account_id: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  reminder_type: 'medicine' | 'exercise' | 'water' | 'custom' | null;
  voice_text: string | null;
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  scheduler_locked_until: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
