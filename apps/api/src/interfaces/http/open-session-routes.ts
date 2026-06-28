import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { PI_THINKING_LEVELS } from '../../shared/types.js';
import type { SessionBoardContext } from '../../shared/token-budget.js';
import { dispatchAiChatPrompt } from '../../runtime/resident-agent.js';
import {
  claimOrRefreshSessionProcessingLock,
  releaseSessionProcessingLock,
} from '../../runtime/ipc-payloads.js';
import {
  archiveChatSession,
  createChatSession,
  createOpenSession,
  findOpenSessionByIdForUser,
  softDeleteOpenSession,
  storeMessage,
  toOpenSessionDto,
  touchOpenSessionActivity,
} from '../../infrastructure/db.js';
import type { OpenSessionRow } from '../../infrastructure/repositories/open-sessions-repository.js';
import {
  WEB_CHAT_USER_NAME,
  getWebChatRuntimeId,
} from '../../modules/chat/web-chat-runtime.js';
import { resolveOfficialRuntimeByModelKey } from '../../modules/system/system-config.js';
import { getRuntimeEntitlementSnapshot } from '../../modules/billing/entitlements.js';
import { requireApiKeyPrincipal, sendOpenAiError } from './api-key-auth.js';

/** FateClaw 扩展字段（建会话时一次性传入，服务端按会话存快照）。 */
const FateclawSessionExtSchema = z
  .object({
    // 开启的 skill：调用方自有/订阅且启用的 skill id（UUID）；归属+启用校验在 runtime 完成。
    skills: z.array(z.string().uuid()).optional(),
    // 思考等级；缺省 medium。
    thinking_level: z.enum(PI_THINKING_LEVELS).optional(),
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
  model: z.string().min(1),
  // 人设（OpenAI 的 system 语义）：作为受约束的 persona 覆盖层，优先级低于平台核心 system。
  system: z.string().optional(),
  fateclaw: FateclawSessionExtSchema,
});

/** 会话忙碌锁 TTL（秒）：与站内 AI Chat 一致，防同会话并发写同一 jsonl 致会话树错乱。 */
const SESSION_PROCESSING_TTL_SECONDS = 2100;

/** POST /api/v1/sessions/:sid/messages 请求体：发一轮消息，只需本轮文本。 */
const SendMessageSchema = z.object({
  content: z.string().min(1),
});

/**
 * 把会话存的盘面快照重建为单个 SessionBoardContext（每轮服务端注入，客户端不重发）。
 *
 * 对外调用方提供的盘面一律按「用户自贴盘面」语义对待（而非平台权威排盘）：调用方能任意构造
 * 请求体，平台不应把其 board 当作可信的官方计算事实，故 source 用 user_pasted_board。
 */
function buildSessionBoardContexts(
  session: OpenSessionRow,
): SessionBoardContext[] | undefined {
  const board = session.board;
  if (!board) return undefined;
  const text =
    board.text?.trim() ||
    (board.data !== undefined ? JSON.stringify(board.data) : '');
  if (!text) return undefined;
  const category = board.type?.trim() || 'board';
  return [
    {
      sourceMessageId: `openapi-board:${session.id}`,
      source: 'user_pasted_board',
      skill: `user-pasted-board::${category}`,
      artifactTitle: `盘面: ${category}`,
      promptText: text,
      artifactData: board.data,
      isCurrent: true,
    },
  ];
}

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

    // 强制官方 metered 运行时；未知/不可用模型直接 400（建会话期即校验，避免事后才发现模型不可用）。
    const runtime = await resolveOfficialRuntimeByModelKey(
      body.model,
      body.fateclaw?.thinking_level,
    );
    if (!runtime) {
      return sendOpenAiError(
        reply,
        400,
        `未知或不可用的模型: ${body.model}`,
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
      modelKey: body.model,
      thinkingLevel: body.fateclaw?.thinking_level ?? null,
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
    const body = parsed.data;

    // 按 sid + 归属用户取会话；不命中即 404（不存在/不归属/已删/已过期），杜绝跨用户 resume。
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

    // 用会话快照重新解析官方运行时；模型在建会话后被下线则 400。
    const runtime = await resolveOfficialRuntimeByModelKey(
      session.model_key,
      (session.thinking_level as (typeof PI_THINKING_LEVELS)[number]) ??
        undefined,
    );
    if (!runtime) {
      return sendOpenAiError(
        reply,
        400,
        `会话使用的模型已不可用: ${session.model_key}`,
        'invalid_request_error',
        'model_not_found',
      );
    }

    const entitlement = await getRuntimeEntitlementSnapshot(principal.userId);
    const accountId = getWebChatRuntimeId(principal.userId);
    // 复用会话内部持久 sessionId → runtime 原生 resume 复原历史；history 恒传 []。
    const runtimeSessionId = session.runtime_session_id;
    const sessionBoardContexts = buildSessionBoardContexts(session);
    const personaPrompt = session.persona_prompt ?? undefined;
    // 省略 fateclaw.skills 时必须传空数组（显式空作用域），不能传 undefined：runtime 的
    // hasExplicitSkillBundleScope 把三个 skill 字段全 undefined 视为「非显式」，会降级为加载
    // 该用户全部 skill（站内 web chat 的语义）。对外 API 是 opt-in 白名单，不传即不加载，
    // 故归一化为 []，与建会话时 skills:[] 入库后的口径一致。
    const authorizedSkillIds = session.authorized_skill_ids ?? [];

    // 进 dispatch 前先抢会话忙碌锁（按 runtime_session_id）：同 sid 并发的第二条立即 409，
    // 不进入 reserve/槽位分配做无用功；requestId 透传给 dispatch，使内部续期与此处同 owner。
    const requestId = randomUUID();
    const lockClaimed = await claimOrRefreshSessionProcessingLock(
      runtimeSessionId,
      requestId,
      SESSION_PROCESSING_TTL_SECONDS,
    );
    if (!lockClaimed) {
      return sendOpenAiError(
        reply,
        409,
        '上一条消息仍在处理中，请稍后再试',
        'invalid_request_error',
        'session_busy',
      );
    }

    try {
      // 先持久化调用方这条用户消息：站内由 chat-session-service 在 dispatch 前存，对外路由
      // 不走那一层，必须在此自己存，否则「API 使用详情」面板只见 AI 回复、看不到用户输入。
      // 放在 dispatch 之前 → timestamp 早于 AI 回复（AI 回复经 outbox 落库），详情页按时间
      // 升序排列时顺序才正确。存失败不阻断本轮回复（仅影响事后归档展示），降级记日志即可。
      try {
        await storeMessage({
          id: randomUUID(),
          account_id: accountId,
          user_id: principal.userId,
          sender: principal.userId,
          sender_name: WEB_CHAT_USER_NAME,
          content: body.content,
          timestamp: new Date().toISOString(),
          is_from_me: false,
          is_bot_message: false,
          session_id: runtimeSessionId,
        });
      } catch (storeErr) {
        request.log.warn(
          { err: storeErr, sid },
          '对外会话用户消息持久化失败（不影响本轮回复）',
        );
      }

      const result = await dispatchAiChatPrompt({
        accountId,
        userMessage: body.content,
        history: [],
        sessionBoardContexts,
        sessionId: runtimeSessionId,
        requestId,
        personaPrompt,
        authorizedSkillIds,
        llmRuntime: runtime,
        entitlementSnapshot: entitlement,
        waitForResponse: true,
      });

      if (result.status === 'error') {
        return sendOpenAiError(
          reply,
          502,
          result.publicErrorText ?? result.error ?? 'Agent 执行失败',
          'api_error',
          result.publicReasonCode ?? 'agent_error',
        );
      }

      // 成功一轮：刷新会话活动时间并顺延 TTL。
      void touchOpenSessionActivity(sid, principal.userId).catch(() => {});

      // 真实 token 用量由 dispatchAiChatPrompt 经 IPC 回传（result.usage，归一化口径、与计费一致）；
      // provider 未上报时回退 0。
      const usage = result.usage;
      return {
        id: `chatcmpl-${result.requestId}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: session.model_key,
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
    } catch (err) {
      // dispatch reject（agent 超时 / 运行时不可用 / 入队失败等上游问题）→ 映射为结构化 502，
      // 而非裸 500：让调用方能稳定区分「请求本身没问题、是 AI 后端失败」。真实错误仅进服务器日志，
      // 不外泄内部细节。
      request.log.error({ err, sid }, '对外会话发消息失败');
      return sendOpenAiError(
        reply,
        502,
        'AI 服务暂时不可用，请稍后重试',
        'api_error',
        'agent_error',
      );
    } finally {
      // 本轮处理完毕（成功 / 失败 / 异常）即释放会话忙碌锁。
      void releaseSessionProcessingLock(runtimeSessionId, requestId).catch(
        () => {},
      );
    }
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
