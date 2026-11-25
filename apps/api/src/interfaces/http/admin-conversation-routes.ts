import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  deleteConversationLogsForAdminUser,
  getChatSessionsForAdmin,
  getConversationLogById,
  getConversationLogByRequestId,
  getConversationLogSummaries,
  getMessagesForAdmin,
  getUserById,
  cleanupPiSessionFilesForAdmin,
  scanPiSessionOrphanFilesForAdmin,
  getAdminChatSessionDetail,
} from '#modules/admin/admin-service';

const PiSessionCleanupSchema = z.object({
  mode: z.enum(['soft_deleted', 'inactive']),
  inactive_days: z.number().int().min(1).max(3650).optional(),
  limit: z.number().int().min(1).max(5000).optional(),
});

const PiSessionOrphanScanSchema = z.object({
  action: z.enum(['audit', 'delete']).default('audit'),
  limit: z.number().int().min(1).max(50_000).optional(),
  sample_limit: z.number().int().min(1).max(100).optional(),
});

export async function adminConversationRoutes(
  app: FastifyInstance,
): Promise<void> {
  // DELETE /api/admin/users/:id/logs — 清空某个用户的全部对话日志
  app.delete('/users/:id/logs', async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = await getUserById(id);
    if (!user) {
      return reply.code(404).send({ error: '用户不存在' });
    }
    const deletedCount = await deleteConversationLogsForAdminUser(id);
    return { success: true, deleted_count: deletedCount };
  });

  // GET /api/admin/messages — 查询消息（支持按用户/账号筛选、分页）
  app.get('/messages', async (request) => {
    const query = request.query as {
      account_id?: string;
      user_id?: string;
      session_id?: string;
      limit?: string;
      offset?: string;
    };
    return getMessagesForAdmin({
      accountId: query.account_id,
      userId: query.user_id,
      sessionId: query.session_id,
      limit: query.limit ? Number(query.limit) : undefined,
      offset: query.offset ? Number(query.offset) : undefined,
    });
  });

  // GET /api/admin/chat-sessions — 查询网页对话窗口（支持按用户/账号筛选、分页）
  app.get('/chat-sessions', async (request) => {
    const query = request.query as {
      account_id?: string;
      user_id?: string;
      limit?: string;
      offset?: string;
    };
    return getChatSessionsForAdmin({
      accountId: query.account_id,
      userId: query.user_id,
      limit: query.limit ? Number(query.limit) : undefined,
      offset: query.offset ? Number(query.offset) : undefined,
    });
  });

  // GET /api/admin/chat-sessions/:sessionId — 查看任意会话完整内容（消息 + 卦象 + 关联客户）
  // 权限：admin:*（不在 user_manager 允许表内，仅 owner 可用；含 tool_context 等高敏感字段）
  app.get<{ Params: { sessionId: string } }>(
    '/chat-sessions/:sessionId',
    async (request, reply) => {
      const { sessionId } = request.params;
      const result = await getAdminChatSessionDetail(sessionId);
      if (!result.ok) {
        return reply.code(result.statusCode).send({ error: result.error });
      }
      return result.data;
    },
  );

  // POST /api/admin/chat-sessions/pi-sessions/cleanup — 清理站内 AI Chat 的 Pi session 本地文件
  app.post('/chat-sessions/pi-sessions/cleanup', async (request, reply) => {
    const parsed = PiSessionCleanupSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: parsed.error.issues[0]?.message || '参数错误' });
    }
    return cleanupPiSessionFilesForAdmin({
      mode: parsed.data.mode,
      inactiveDays: parsed.data.inactive_days,
      limit: parsed.data.limit,
    });
  });

  // POST /api/admin/chat-sessions/pi-sessions/orphans/scan — 审计/删除安全的 Pi session 孤儿文件
  app.post(
    '/chat-sessions/pi-sessions/orphans/scan',
    async (request, reply) => {
      const parsed = PiSessionOrphanScanSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: parsed.error.issues[0]?.message || '参数错误' });
      }
      return scanPiSessionOrphanFilesForAdmin({
        action: parsed.data.action,
        limit: parsed.data.limit,
        sampleLimit: parsed.data.sample_limit,
      });
    },
  );

  // GET /api/admin/logs?accountId=xxx&limit=20&before=xxx — 查看完整对话日志
  app.get<{
    Querystring: { accountId?: string; limit?: string; before?: string };
  }>('/logs', async (request, reply) => {
    const { accountId, limit: limitStr, before } = request.query;
    if (!accountId) {
      return reply.code(400).send({ error: '缺少 accountId 参数' });
    }
    const limit = Math.min(parseInt(limitStr || '20', 10) || 20, 100);
    return getConversationLogSummaries(accountId, limit, before || undefined);
  });

  // GET /api/admin/logs/:logId — 查看单条完整日志
  app.get<{ Params: { logId: string } }>(
    '/logs/:logId',
    async (request, reply) => {
      const log = await getConversationLogById(request.params.logId);
      if (!log) {
        return reply.code(404).send({ error: '日志不存在' });
      }
      return log;
    },
  );

  // GET /api/admin/logs/by-request/:requestId — 按 requestId 精确定位单条日志
  //
  // **注意**：本接口返回的 trace_events 包含 tool_call args、prompt preview 等
  // 高敏感数据，仅限 admin 排障使用。鉴权由路由前缀的全局 onRequest hook
  // （x-admin-key 校验）保证，不要把此接口暴露到普通用户路径。
  app.get<{ Params: { requestId: string } }>(
    '/logs/by-request/:requestId',
    async (request, reply) => {
      const log = await getConversationLogByRequestId(request.params.requestId);
      if (!log) {
        return reply.code(404).send({ error: '日志不存在' });
      }
      return log;
    },
  );
}
