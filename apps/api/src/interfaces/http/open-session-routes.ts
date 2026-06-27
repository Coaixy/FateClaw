import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { PI_THINKING_LEVELS } from '../../shared/types.js';
import type { SessionBoardContext } from '../../shared/token-budget.js';
import { dispatchAiChatPrompt } from '../../runtime/resident-agent.js';
import {
  aiChatStreamChannel,
  type AiChatStreamEvent,
} from '../../runtime/ai-chat-stream.js';
import { cancelAiChatSessionRequest } from '../../runtime/ipc-worker.js';
import {
  claimOrRefreshSessionProcessingLock,
  releaseSessionProcessingLock,
} from '../../runtime/ipc-payloads.js';
import { getRedis } from '../../infrastructure/redis.js';
import {
  createOpenSession,
  findOpenSessionByIdForUser,
  softDeleteOpenSession,
  toOpenSessionDto,
  touchOpenSessionActivity,
} from '../../infrastructure/db.js';
import type { OpenSessionRow } from '../../infrastructure/repositories/open-sessions-repository.js';
import { getWebChatRuntimeId } from '../../modules/chat/web-chat-runtime.js';
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
  stream: z.boolean().optional().default(false),
  // OpenAI 流式可选项；include_usage=true 时在流末尾追加一条仅含 usage 的 chunk。
  stream_options: z
    .object({ include_usage: z.boolean().optional() })
    .optional(),
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

    const row = await createOpenSession({
      userId: principal.userId,
      apiKeyId: principal.apiKeyId,
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
    const authorizedSkillIds = session.authorized_skill_ids ?? undefined;

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

    if (body.stream) {
      // 真流式：订阅会话的 Redis 流 channel，把内部增量事件译成 OpenAI chat.completion.chunk SSE。
      // 先订阅再 dispatch，避免错过早期 assistant_delta；dispatch 用 waitForResponse:false 不阻塞，
      // agent 仍由内部 outbox listener 驱动，计费照常结算，路由不重复结算。
      const chunkId = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      const includeUsage = body.stream_options?.include_usage === true;
      const sub = getRedis().duplicate();

      try {
        await sub.connect();
        await sub.subscribe(aiChatStreamChannel(runtimeSessionId));
      } catch (err) {
        request.log.error(
          { err, sid, runtimeSessionId },
          '开放会话流式订阅失败',
        );
        await sub.quit().catch(() => {});
        void releaseSessionProcessingLock(runtimeSessionId, requestId).catch(
          () => {},
        );
        return sendOpenAiError(
          reply,
          500,
          '流式订阅失败',
          'api_error',
          'internal_error',
        );
      }

      // 订阅成功后劫持响应：此后 /api/v1 的 onSend / setErrorHandler 不再生效，错误须手动写帧。
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      let finished = false;
      const writeChunk = (obj: unknown) => {
        if (!finished) reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
      };
      // 周期心跳注释帧：保活长连接并探测死链。
      const heartbeat = setInterval(() => {
        if (!finished) reply.raw.write(': ping\n\n');
      }, 15000);
      heartbeat.unref();

      // 本轮是否已转发过 assistant_delta 增量：决定 final 是否需要用 final.text 兜底补正文。
      let sawDelta = false;
      const cleanup = async (cancel: boolean) => {
        clearInterval(heartbeat);
        await sub.quit().catch(() => {});
        // 释放会话忙碌锁（与 dispatch 内部续期同 owner，安全删除）。
        void releaseSessionProcessingLock(runtimeSessionId, requestId).catch(
          () => {},
        );
        // 客户端中途断开时取消 agent，避免空跑继续计费。
        if (cancel) {
          void cancelAiChatSessionRequest(
            runtimeSessionId,
            accountId,
            'client_disconnect',
          ).catch(() => {});
        }
      };
      // 收尾：写 [DONE] 不经 finished 守卫（守卫用于阻止后续 chunk，不能阻止收尾本身）。
      const finish = () => {
        if (finished) return;
        finished = true;
        reply.raw.write('data: [DONE]\n\n');
        reply.raw.end();
        void cleanup(false);
      };

      // 首包：声明 assistant 角色（OpenAI 约定）。
      writeChunk({
        id: chunkId,
        object: 'chat.completion.chunk',
        created,
        model: session.model_key,
        choices: [
          { index: 0, delta: { role: 'assistant' }, finish_reason: null },
        ],
      });

      sub.on('message', (_channel, message) => {
        if (finished) return;
        let event: AiChatStreamEvent;
        try {
          event = JSON.parse(message) as AiChatStreamEvent;
        } catch {
          return;
        }
        switch (event.type) {
          case 'assistant_delta':
            // 只转发增量正文；assistant_message/message 含整段文本，转发会与 delta 重复。
            if (event.delta) {
              sawDelta = true;
              writeChunk({
                id: chunkId,
                object: 'chat.completion.chunk',
                created,
                model: session.model_key,
                choices: [
                  {
                    index: 0,
                    delta: { content: event.delta },
                    finish_reason: null,
                  },
                ],
              });
            }
            break;
          case 'final':
            // 防御性分支：final 实际只在成功时发布（error 走下方 case 'error'），此处恒不命中。
            if (event.status === 'error') {
              writeChunk({
                error: {
                  message: '生成失败',
                  type: 'api_error',
                  code: 'agent_error',
                  param: null,
                },
              });
              finish();
              break;
            }
            // 成功一轮：刷新会话活动时间并顺延 TTL。
            void touchOpenSessionActivity(sid, principal.userId).catch(() => {});
            // 兜底：若本轮无任何 assistant_delta 增量（如某轮仅 turn_end 出文本），用 final.text
            // 补一条 content chunk，避免流式丢失正文、与非流式口径不一致。
            if (!sawDelta && event.text) {
              writeChunk({
                id: chunkId,
                object: 'chat.completion.chunk',
                created,
                model: session.model_key,
                choices: [
                  { index: 0, delta: { content: event.text }, finish_reason: null },
                ],
              });
            }
            // 终止 chunk：空 delta + finish_reason。
            writeChunk({
              id: chunkId,
              object: 'chat.completion.chunk',
              created,
              model: session.model_key,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            });
            // 可选 usage chunk（仅当客户端 stream_options.include_usage 且有用量；usage 已归一化）。
            if (includeUsage && event.usage) {
              writeChunk({
                id: chunkId,
                object: 'chat.completion.chunk',
                created,
                model: session.model_key,
                choices: [],
                usage: {
                  prompt_tokens: event.usage.promptTokens ?? 0,
                  completion_tokens: event.usage.completionTokens ?? 0,
                  total_tokens: event.usage.totalTokens ?? 0,
                },
              });
            }
            finish();
            break;
          case 'error':
            writeChunk({
              error: {
                message:
                  event.publicErrorText ?? event.error ?? 'Agent 执行失败',
                type: 'api_error',
                code: event.publicReasonCode ?? 'agent_error',
                param: null,
              },
            });
            finish();
            break;
          default:
            // thinking_delta / message / assistant_message / progress / tool_* / agent_* 等忽略。
            break;
        }
      });

      // 客户端断连：清理订阅并取消 agent。
      reply.raw.on('close', () => {
        if (finished) return;
        finished = true;
        void cleanup(true);
      });

      // 触发执行（不阻塞）；dispatch 期错误手动写 error 帧后收尾。
      void dispatchAiChatPrompt({
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
        waitForResponse: false,
      }).catch((err) => {
        request.log.error(
          { err, sid, runtimeSessionId },
          '开放会话流式分发失败',
        );
        if (!finished) {
          writeChunk({
            error: {
              message: 'Agent 执行失败',
              type: 'api_error',
              code: 'agent_error',
              param: null,
            },
          });
          finish();
        }
      });

      return;
    }

    try {
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
    const deleted = await softDeleteOpenSession({
      id: sid,
      userId: principal.userId,
    });
    if (!deleted) {
      return sendOpenAiError(
        reply,
        404,
        '会话不存在或无权访问',
        'invalid_request_error',
        'session_not_found',
      );
    }
    return { id: sid, object: 'session', deleted: true };
  });
}
