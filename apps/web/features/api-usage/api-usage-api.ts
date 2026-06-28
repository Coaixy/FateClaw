import { requestJson } from '@/lib/http/client';

/** 站内「API 使用详情」会话列表项（对应后端 OpenSessionListItem）。 */
export interface ApiSessionListItem {
  id: string;
  object: 'session';
  model: string;
  status: 'active' | 'deleted';
  created_at: string;
  last_active_at: string;
  expires_at: string | null;
  /** 该会话累计未删除消息条数（用户 + AI）。 */
  message_count: number;
  /** 创建该会话所用 API Key 的名称；Key 已删则为 null。 */
  api_key_name: string | null;
}

/** 会话内单条消息（对应后端 OpenSessionMessageItem）。 */
export interface ApiSessionMessage {
  id: string;
  /** 'user' = 调用方发送；'assistant' = AI 回复。 */
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

/** 会话详情头信息。 */
export interface ApiSessionDetail {
  id: string;
  model: string;
  status: 'active' | 'deleted';
  created_at: string;
  last_active_at: string;
}

const pathSegment = (value: string) => encodeURIComponent(value);

/**
 * 站内「API 使用详情」的浏览器侧封装。
 *
 * 对接后端 `/api/open-sessions`（站内 JWT 鉴权），列出当前用户经 API Key 创建的会话及其对话。
 * 这些会话不出现在普通聊天历史里，故在此独立面板查看。
 */
export const apiUsageApi = {
  /** 列出当前用户的全部 API 会话（含已软删，带消息数与来源 Key）。 */
  listSessions: () =>
    requestJson<{ sessions: ApiSessionListItem[] }>('/api/open-sessions'),
  /** 查看某会话的完整对话。 */
  sessionMessages: (sid: string) =>
    requestJson<{ session: ApiSessionDetail; messages: ApiSessionMessage[] }>(
      `/api/open-sessions/${pathSegment(sid)}/messages`,
    ),
};
