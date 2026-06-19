// --- FateClaw Types ---

export type UserRole = 'consumer' | 'creator' | 'both' | 'admin';

export interface User {
  id: string;
  phone: string | null;
  phone_verified: boolean;
  password_hash: string | null;
  auth_token_version?: number; // 认证令牌版本，改密后递增以撤销旧 JWT
  role: UserRole; // 'consumer'（默认） | 'creator' | 'both' | 'admin'
  purchased_coins: number; // 充值积分（不过期，可消费）
  bonus_coins: number; // 赠送积分（可过期，消费优先扣）
  reserved_coins: number; // 历史冻结余额字段，当前模型扣费不再使用
  soul_content?: string; // 用户级 Soul 自定义人格，供站内 AI Chat 注入
  soul_edit_enabled?: boolean; // 是否允许 Pi 在对话中编辑用户级 Soul
  created_at: string;
}

export type BalanceSource = 'purchased' | 'bonus' | 'mixed';

export type BalanceGrantSource =
  | 'new_user_gift'
  | 'sign_in'
  | 'gift_code'
  | 'admin_grant'
  | 'promotion';

export type BalanceGrantStatus = 'active' | 'exhausted' | 'expired' | 'revoked';

export interface MembershipConfig {
  id: 'default' | string;
  enabled: boolean;
  name: string;
  monthly_price_coins: number;
  display_price_coins: number;
  monthly_allowance_units: number;
  standard_price_per_million_units_coins: number;
  updated_at: string;
}

export type UserMembershipStatus = 'active' | 'cancelled';

export interface UserMembership {
  user_id: string;
  plan_key: string;
  status: UserMembershipStatus;
  current_period_start: string;
  current_period_end: string;
  created_at: string;
  updated_at: string;
}

export interface MembershipAllowance {
  id: string;
  user_id: string;
  plan_key: string;
  period_start: string;
  period_end: string;
  allowance_units: number;
  used_units: number;
  created_at: string;
  updated_at: string;
}

export interface BalanceGrant {
  id: string;
  user_id: string;
  source: BalanceGrantSource | string;
  granted_by: string | null;
  amount_coins: number;
  remaining_coins: number;
  note: string | null;
  expires_at: string | null;
  status: BalanceGrantStatus;
  created_at: string;
  updated_at: string;
}

export interface UserSkill {
  user_id: string;
  skill_name: string;
  enabled: boolean;
  enabled_at: string;
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
  source_kind: 'share' | 'bundle_share' | 'invite' | 'bundle_invite';
  status: 'active' | 'expired' | 'cancelled';
  enabled: boolean;
  expires_at: string | null;
  started_at: string;
  subscribed_at: string;
}

/** Skill 公开赞踩类型。 */
export type SkillReactionKind = 'like' | 'dislike';

/** Skill 评论审核状态。 */
export type SkillCommentStatus = 'pending' | 'approved' | 'rejected';

/** 用户对公开 Skill 的赞踩记录。 */
export interface SkillReaction {
  skill_id: string;
  user_id: string;
  kind: SkillReactionKind;
  created_at: string;
  updated_at: string;
}

/**
 * Skill 评论原始行。
 *
 * @remarks 公开接口必须通过 DTO 过滤 user_id，避免破坏匿名承诺。
 */
export interface SkillComment {
  id: string;
  skill_id: string;
  user_id: string;
  body: string;
  status: SkillCommentStatus;
  pinned: boolean;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 私密授权链接可绑定的目标类型。 */
export type SkillAccessInviteTargetType = 'skill' | 'bundle';

/**
 * 作者生成的私密授权链接。
 *
 * @remarks 平台只记录授权领取所需信息，不包含价格、订单或分成字段。
 */
export interface SkillAccessInvite {
  id: string;
  creator_id: string;
  target_type: SkillAccessInviteTargetType;
  target_id: string;
  token: string;
  max_redemptions: number;
  redeemed_count: number;
  expires_at: string | null;
  revoked_at: string | null;
  note: string;
  created_at: string;
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
  /** 私密分享令牌；为空表示没有开放分享链接。 */
  share_token?: string | null;
  /** 首次生成分享令牌的时间。 */
  share_created_at?: string | null;
  /** Pi session 本地 jsonl/path 已归档到数据库的时间。 */
  pi_session_archived_at?: string | null;
  /** Pi session 归档原因。 */
  pi_session_archive_reason?: 'soft_deleted' | 'inactive' | string | null;
  /** Pi session 归档内容，可回写为本地 jsonl/path 文件。 */
  pi_session_archive_payload?: unknown;
  /** 最近一次从数据库归档回写成本地文件的时间。 */
  pi_session_archive_restored_at?: string | null;
  /** 关联的客户档案 id；未关联或客户被删除时为空。 */
  client_id?: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/**
 * 客户（被算者）档案表行。
 *
 * @remarks 归属卦师（user_id）；gender 存中文 '男'/'女'；deleted_at 为软删除标记。
 * solar_date/hour/minute 为可空生辰，关联排盘时用于预填排盘输入。
 */
export interface ClientProfile {
  id: string;
  user_id: string;
  name: string;
  gender: string | null;
  solar_date: string | null;
  hour: number | null;
  minute: number | null;
  birthplace: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/**
 * 微信 sender 与网页 AI Chat 会话的接续映射。
 *
 * @remarks sender_hash 必须是去标识化值，避免持久化外部微信 ID。
 */
export interface WechatChatSessionLink {
  /** 微信 Claw 账号 ID。 */
  account_id: string;
  /** 去标识化后的微信发送方哈希。 */
  sender_hash: string;
  /** 绑定的 FateClaw 用户 ID。 */
  user_id: string;
  /** 当前接续的 chat_sessions.id。 */
  session_id: string;
  created_at: string;
  updated_at: string;
  last_used_at: string;
}

export type ModelProviderType =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai';

/** Pi runtime 可选的思考等级，和底层 Pi SDK 的 ThinkingLevel 保持一致。 */
export const PI_THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const;

/** 用户模型选择中保存的 Pi 思考等级。 */
export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

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
  input_token_price_per_million_coins: number;
  output_token_price_per_million_coins: number;
  extra_json: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

/**
 * 自配模型平台服务费的全局配置。
 *
 * @remarks 价格单位是积分 / 百万 Token，输入和输出 Token 使用同一价格。
 */
export interface ModelBillingConfig {
  id: 'default' | string;
  custom_model_platform_price_per_million_coins: number;
  updated_at: string;
}

/**
 * Agent 运行时全局配置。
 *
 * @remarks 并发上限控制宿主侧进入 agent-runtime 的全站请求槽位。
 */
export interface RuntimeConfig {
  id: 'default' | string;
  agent_concurrency_limit: number;
  local_agent_max_processes: number;
  local_agent_idle_ttl_ms: number;
  /** 后台指定的系统默认官方模型；为空时按价格最低的可用官方模型兜底。 */
  default_official_model_id: string | null;
  /** 后台指定的新用户默认 Pi 思考等级。 */
  default_thinking_level: PiThinkingLevel;
  pi_session_health_enabled: boolean;
  pi_session_inactive_cleanup_days: number;
  pi_session_orphan_grace_days: number;
  /** 用户可创建的自定义 Skill 数量上限。 */
  user_skill_max_count: number;
  skill_bundle_max_files: number;
  skill_bundle_max_file_chars: number;
  skill_bundle_max_total_chars: number;
  skill_bundle_max_zip_bytes: number;
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
  /** 本用户当前模型调用使用的 Pi 思考等级，历史记录缺失时按 medium 处理。 */
  thinking_level?: PiThinkingLevel;
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

export type SimpleWorkflowKind = 'divination' | 'natal';

export type SimpleWorkflowPaipanSkill = 'iching-paipan' | 'bazi-paipan';

export type SimpleModelPolicyMode = 'system-default' | 'user-current' | 'fixed';

export type SimpleModelThinkingLevel =
  | 'off'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh';

export interface SimpleModelPolicy {
  mode: SimpleModelPolicyMode;
  fixedModelId?: string;
  thinkingLevel?: SimpleModelThinkingLevel;
}

export interface SimpleWorkflowPreset {
  id: string;
  kind: SimpleWorkflowKind;
  name: string;
  enabled: boolean;
  is_default: boolean;
  entry_title: string;
  entry_description: string;
  paipan_skill: SimpleWorkflowPaipanSkill;
  paipan_input_defaults: Record<string, unknown>;
  model_policy: SimpleModelPolicy;
  skill_bundle_ids: string[];
  skill_ids: string[];
  skill_snapshot_ids: string[];
  prompt_template: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
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
