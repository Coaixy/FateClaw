/**
 * 对外开放 API Key 域跨端契约（运行时常量 + 类型）。
 *
 * @remarks
 * 平台颁发给会员、用于程序化调用对外开放 API（/api/v1/*）的 Key。所有字段对外 snake_case。
 * 明文 key 只在「生成」响应里返回一次（见 {@link ApiKeyCreatedDto}），其余场景一律脱敏，
 * 只暴露 key_prefix + last_four。
 */

/** 每用户允许同时持有的有效 API Key 数量上限。 */
export const MAX_API_KEYS_PER_USER = 10;

/** 平台颁发 key 的环境前缀（用于识别与脱敏展示）。 */
export const API_KEY_LIVE_PREFIX = 'fc_live_';

/** API Key 状态：active 可用、revoked 已吊销（软状态，保留审计痕迹）。 */
export type ApiKeyStatus = 'active' | 'revoked';

/** API Key 脱敏视图（列表 / 管理展示用，绝不含明文）。 */
export interface ApiKeyDto {
  id: string;
  /** 用户自定义名称，便于区分用途。 */
  name: string;
  /** 环境前缀，如 fc_live_。 */
  key_prefix: string;
  /** 明文 key 的后 4 位，仅用于辨识，无法据此还原明文。 */
  last_four: string;
  status: ApiKeyStatus;
  /** 最近一次调用时间（ISO 8601）；从未使用为 null。 */
  last_used_at: string | null;
  /** 创建时间（ISO 8601）。 */
  created_at: string;
  /** 过期时间（ISO 8601）；null 表示永不过期。 */
  expires_at: string | null;
}

/**
 * 生成 API Key 的响应。
 *
 * @remarks key 为完整明文，**仅在本响应返回一次**，服务端只存哈希，之后无法再取。
 */
export interface ApiKeyCreatedDto extends ApiKeyDto {
  /** 完整明文 key，仅此一次返回，请妥善保存。 */
  key: string;
}

/** 创建 API Key 的请求体。 */
export interface CreateApiKeyRequest {
  /** key 名称，1-50 字符。 */
  name: string;
  /** 可选过期时间（ISO 8601）；不传或为 null 表示永不过期。 */
  expires_at?: string | null;
}

/** 列出当前用户 API Key 的响应。 */
export interface ListApiKeysResponse {
  api_keys: ApiKeyDto[];
}
