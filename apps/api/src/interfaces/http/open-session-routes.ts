import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { runOpenSessionTurn } from '#modules/chat/open-session-turn';
import {
  archiveChatSession,
  createChatSession,
  createOpenSession,
  findOpenSessionByIdForUser,
  softDeleteOpenSession,
  toOpenSessionDto,
} from '#infrastructure/db';
import { getWebChatRuntimeId } from '#modules/chat/web-chat-runtime';
import { resolveOfficialRuntimeByModelKey } from '#modules/system/system-config';
import { requireApiKeyPrincipal, sendOpenAiError } from './api-key-auth.js';

/** FateClaw 扩展字段（建会话时一次性传入，服务端按会话存快照）。 */
const FateclawSessionExtSchema = z
  .strictObject({
    // 开启的 skill：调用方自有/订阅且启用的 skill id（UUID）；归属+启用校验在 runtime 完成。
    skills: z.array(z.string().uuid()).optional(),
    // 排盘结果（解读场景）：来自 /api/v1/paipan/:type 的输出，会话级注入、每轮无需重发。
    board: z
      .object({
        type: z.string().optional(),
        text: z.string().optional(),
        data: z.unknown().optional(),
      })
      .optional(),
  })
  .optional();

/** POST /api/v1/sessions 请求体：建会话，一次性传 model / system(persona) / fateclaw 扩展。 */
const CreateSessionSchema = z.object({
  model: z.string().trim().min(1).optional(),
  // 人设（OpenAI 的 system 语义）：作为受约束的 persona 覆盖层，优先级低于平台核心 system。
  system: z.string().optional(),
  fateclaw: FateclawSessionExtSchema,
});

/** POST /api/v1/sessions/:sid/messages 请求体：发一轮消息，只需本轮文本。 */
const SendMessageSchema = z.object({
  content: z.string().min(1),
});

/**
 * 对外开放「有状态会话」路由（挂在 /api/v1/sessions 下，鉴权 + 错误体由父插件统一注入）。
 *
 * 取代旧的 OpenAI 无状态 /chat/completions：调用方建会话时一次性传 model/system/board/skills 拿到
 * 不可猜的 public sid（DB 映射到内部 runtime sessionId，绝不外泄后者）；之后每轮只发 {content}，
 * 历史由 runtime 原生 resume 复原（history 恒传 []），board/persona/skills 每轮从会话快照重建注入。
 * 计费（reserve/settle）与 usage 回填全在 dispatchAiChatPrompt 内部完成，本路由绝不重复结算。
 */
export async function openSessionRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/v1/sessions — 建会话。
  app.post('/', async (request, reply) => {
    const principal = requireApiKeyPrincipal(request);

    const parsed = CreateSessionSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendOpenAiError(
        reply,
        400,
        parsed.error.issues[0]?.message ?? '请求体无效',
        'invalid_request_error',
        'invalid_request',
      );
    }
    const body = parsed.data;

    const runtime = await resolveOfficialRuntimeByModelKey(body.model);
    if (!runtime) {
      return sendOpenAiError(
        reply,
        400,
        '官方模型暂不可用，或模型标识不正确',
        'invalid_request_error',
        'model_not_found',
      );
    }

    // 先建一行 chat_sessions 兜住 messages 表外键（dispatchAiChatPrompt 的 outbox 持久化
    // 会按 sessionId 写 messages，FK → chat_sessions(id)）。runtime_session_id 即该行 id，
    // 与 open_sessions 行一致。必须先于 open_sessions 创建，确保发消息时外键已就绪。
    const runtimeSessionId = `openapi:${randomUUID()}`;
    await createChatSession({
      id: runtimeSessionId,
      accountId: getWebChatRuntimeId(principal.userId),
      userId: principal.userId,
      title: 'API 会话',
    });

    const row = await createOpenSession({
      userId: principal.userId,
      apiKeyId: principal.apiKeyId,
      runtimeSessionId,
      modelKey: runtime.providerKey,
      thinkingLevel: runtime.thinkingLevel,
      persona: body.system ?? null,
      skillIds: body.fateclaw?.skills ?? null,
      board: body.fateclaw?.board ?? null,
    });
    reply.code(201);
    return toOpenSessionDto(row);
  });

  // POST /api/v1/sessions/:sid/messages — 发一轮消息（核心）。
  app.post('/:sid/messages', async (request, reply) => {
    const principal = requireApiKeyPrincipal(request);
    const { sid } = request.params as { sid: string };

    const parsed = SendMessageSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendOpenAiError(
        reply,
        400,
        parsed.error.issues[0]?.message ?? '请求体无效',
        'invalid_request_error',
        'invalid_request',
      );
    }
    const turn = await runOpenSessionTurn({
      userId: principal.userId,
      sessionId: sid,
      content: parsed.data.content,
    });
    switch (turn.status) {
      case 'session_not_found':
        return sendOpenAiError(
          reply,
          404,
          '会话不存在或无权访问',
          'invalid_request_error',
          turn.status,
        );
      case 'model_not_found':
        return sendOpenAiError(
          reply,
          400,
          '官方模型暂不可用',
          'invalid_request_error',
          turn.status,
        );
      case 'session_busy':
        return sendOpenAiError(
          reply,
          409,
          '上一条消息仍在处理中，请稍后再试',
          'invalid_request_error',
          turn.status,
        );
      case 'agent_error':
        return sendOpenAiError(
          reply,
          502,
          turn.message,
          'api_error',
          turn.code,
        );
    }
    const { result } = turn;
    const usage = result.usage;
    return {
      id: `chatcmpl-${result.requestId}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: turn.providerKey,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: result.text ?? '' },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: usage?.promptTokens ?? 0,
        completion_tokens: usage?.completionTokens ?? 0,
        total_tokens: usage?.totalTokens ?? 0,
      },
    };
  });

  // GET /api/v1/sessions/:sid — 查会话元信息（不返回历史正文）。
  app.get('/:sid', async (request, reply) => {
    const principal = requireApiKeyPrincipal(request);
    const { sid } = request.params as { sid: string };
    const session = await findOpenSessionByIdForUser(sid, principal.userId);
    if (!session) {
      return sendOpenAiError(
        reply,
        404,
        '会话不存在或无权访问',
        'invalid_request_error',
        'session_not_found',
      );
    }
    return toOpenSessionDto(session);
  });

  // DELETE /api/v1/sessions/:sid — 软删会话（之后该 sid 续聊即 404）。
  app.delete('/:sid', async (request, reply) => {
    const principal = requireApiKeyPrincipal(request);
    const { sid } = request.params as { sid: string };
    const runtimeSessionId = await softDeleteOpenSession({
      id: sid,
      userId: principal.userId,
    });
    if (!runtimeSessionId) {
      return sendOpenAiError(
        reply,
        404,
        '会话不存在或无权访问',
        'invalid_request_error',
        'session_not_found',
      );
    }
    // 同步归档对应 chat_sessions（软删，不再出现在历史列表）。
    await archiveChatSession(runtimeSessionId).catch(() => {});
    return { id: sid, object: 'session', deleted: true };
  });
}
