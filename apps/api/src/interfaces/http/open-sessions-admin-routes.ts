import type { FastifyInstance } from 'fastify';

import {
  getOpenSessionForUserAnyStatus,
  getSessionMessages,
  listOpenSessionsByUserId,
} from '#infrastructure/db';
import { getWebChatRuntimeId } from '#modules/chat/web-chat-runtime';

/** 单条会话消息的脱敏视图：只暴露角色 / 正文 / 时间，隐去 account_id 等内部字段。 */
interface OpenSessionMessageItem {
  id: string;
  /** 'user' = 调用方发送；'assistant' = AI 回复。 */
  role: 'user' | 'assistant';
  content: string;
  /** 消息时间（ISO 8601）。 */
  created_at: string;
}

/**
 * 对外开放会话的「使用详情」路由（站内，JWT 鉴权）。
 *
 * 站内通过 API Key 创建的会话不出现在普通聊天历史里（已在 chat-repository 过滤掉 openapi:* 会话），
 * 故单独提供此面板：登录用户在网页端查看自己创建的 API 会话列表与每个会话的完整对话。
 * 与「调用面」（/api/v1/* 用 api-key 鉴权）分离，沿用内部统一的 { error: 中文 } 错误体。
 */
export async function openSessionsAdminRoutes(
  app: FastifyInstance,
): Promise<void> {
  // 全部接口要求登录态。
  app.addHook('onRequest', async (request) => {
    await request.requireAuth();
  });

  // GET /api/open-sessions — 列出当前用户的全部 API 会话（含已软删，带消息数与来源 Key）。
  app.get('/', async (request) => {
    const sessions = await listOpenSessionsByUserId(request.user.userId);
    return { sessions };
  });

  // GET /api/open-sessions/:sid/messages — 查看某会话的完整对话。
  app.get('/:sid/messages', async (request, reply) => {
    const { sid } = request.params as { sid: string };
    const userId = request.user.userId;

    // 按 sid + userId 反查会话（不限状态，软删会话也允许回看），同时完成跨用户归属隔离。
    const session = await getOpenSessionForUserAnyStatus(sid, userId);
    if (!session) {
      return reply.code(404).send({ error: '会话不存在' });
    }

    // 对外会话的消息落在 account_id = web:{userId}、session_id = runtime_session_id 下。
    const rows = await getSessionMessages(
      getWebChatRuntimeId(userId),
      session.runtime_session_id,
    );

    // 只透出有正文的消息（跳过 progress 等无正文中间事件），脱敏为 role / content / time。
    const messages: OpenSessionMessageItem[] = rows
      .filter((m) => typeof m.content === 'string' && m.content.trim() !== '')
      .map((m) => ({
        id: m.id,
        role: m.is_bot_message ? 'assistant' : 'user',
        content: m.content,
        // pg 对 TIMESTAMPTZ 返回 Date；Fastify 序列化时统一转 ISO，前端按字符串解析即可。
        created_at: m.timestamp,
      }));

    return {
      session: {
        id: session.id,
        model: session.model_key,
        status: session.status,
        created_at: session.created_at.toISOString(),
        last_active_at: session.last_active_at.toISOString(),
      },
      messages,
    };
  });
}
