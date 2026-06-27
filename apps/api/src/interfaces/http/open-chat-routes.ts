import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { PI_THINKING_LEVELS } from '../../shared/types.js';
import { dispatchAiChatPrompt } from '../../runtime/resident-agent.js';
import {
  aiChatStreamChannel,
  type AiChatStreamEvent,
} from '../../runtime/ai-chat-stream.js';
import { cancelAiChatSessionRequest } from '../../runtime/ipc-worker.js';
import { getRedis } from '../../infrastructure/redis.js';
import { getWebChatRuntimeId } from '../../modules/chat/web-chat-runtime.js';
import { resolveOfficialRuntimeByModelKey } from '../../modules/system/system-config.js';
import { getRuntimeEntitlementSnapshot } from '../../modules/billing/entitlements.js';
import { requireApiKeyPrincipal, sendOpenAiError } from './api-key-auth.js';

/** OpenAI 风格消息。 */
const ChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
});

/** FateClaw 扩展字段（非 OpenAI 标准，OpenAI SDK 经 extra_body 传入）。 */
const FateclawExtSchema = z
  .object({
    // 开启的 skill；当前按 bundle 维度透传（见下方 TODO）。用 skill id(UUID)。
    skills: z.array(z.string()).optional(),
    // 思考等级；缺省 medium。
    thinking_level: z.enum(PI_THINKING_LEVELS).optional(),
    // 排盘结果（解读场景）：来自 /api/v1/paipan/:type 的输出。
    board: z
      .object({
        type: z.string().optional(),
        text: z.string().optional(),
        data: z.unknown().optional(),
      })
      .optional(),
  })
  .optional();

/** POST /api/v1/chat/completions 请求体（OpenAI 兼容 + fateclaw 扩展）。 */
const ChatCompletionSchema = z.object({
  model: z.string().min(1),
  messages: z.array(ChatMessageSchema).min(1),
  stream: z.boolean().optional().default(false),
  // OpenAI 流式可选项；include_usage=true 时在流末尾追加一条仅含 usage 的 chunk。
  stream_options: z
    .object({ include_usage: z.boolean().optional() })
    .optional(),
  max_tokens: z.number().int().positive().optional(),
  fateclaw: FateclawExtSchema,
});

/**
 * 对外开放 Agent 路由（OpenAI 兼容，挂在 /api/v1/chat 下）。
 *
 * 桥接现有异步 Redis-IPC 运行时：把 OpenAI Chat Completions 请求映射为 ContainerInput，
 * 经 dispatchAiChatPrompt 执行。**计费（reserve/settle）已在该函数内部完成，本路由绝不重复结算。**
 * 强制使用平台官方 metered 模型（忽略调用方个人模型选择），符合「仅官方模型按 token 计费」决策。
 */
export async function openChatRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/v1/chat/completions
  app.post('/completions', async (request, reply) => {
    const principal = requireApiKeyPrincipal(request);

    const parsed = ChatCompletionSchema.safeParse(request.body);
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

    // 取最后一条 user 消息作为本轮 prompt；system 消息作为 persona。
    const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) {
      return sendOpenAiError(
        reply,
        400,
        'messages 中至少需要一条 user 消息',
        'invalid_request_error',
        'invalid_request',
      );
    }
    const systemPrompt = body.messages.find((m) => m.role === 'system')?.content;

    // 强制官方 metered 运行时；未知/不可用模型直接 400。
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
    if (body.max_tokens) {
      runtime.maxOutputTokens = body.max_tokens;
    }

    const entitlement = await getRuntimeEntitlementSnapshot(principal.userId);
    const accountId = getWebChatRuntimeId(principal.userId);
    const sessionId = `openapi:${randomUUID()}`; // 对外每次调用独立会话。

    // 排盘 board → pastedBoard 注入（解读场景）。
    const board = body.fateclaw?.board;
    const pastedBoard = board
      ? {
          category: board.type ?? 'paipan',
          content: board.text ?? JSON.stringify(board.data ?? {}),
          question: lastUser.content,
        }
      : undefined;

    // TODO(skills): 当前按 bundle 维度透传 fateclaw.skills。按「单个 skill id」开启需新增
    //   agent-db queryEffectiveUserSkillsByIds + ContainerInput.authorizedSkillIds（设计文档 §7.6）。
    const authorizedSkillBundleIds = body.fateclaw?.skills;

    if (body.stream) {
      // 真流式：订阅会话的 Redis 流 channel，把内部增量事件译成 OpenAI chat.completion.chunk SSE。
      // 先订阅再 dispatch，避免错过早期 assistant_delta；dispatch 用 waitForResponse:false 不阻塞，
      // agent 仍由内部 outbox listener 驱动，计费照常结算、final 事件照常发布，路由不重复结算。
      const chunkId = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      const includeUsage = body.stream_options?.include_usage === true;
      const sub = getRedis().duplicate();

      try {
        await sub.connect();
        await sub.subscribe(aiChatStreamChannel(sessionId));
      } catch (err) {
        request.log.error({ err, sessionId }, '开放 API 流式订阅失败');
        await sub.quit().catch(() => {});
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

      const cleanup = async (cancel: boolean) => {
        clearInterval(heartbeat);
        await sub.quit().catch(() => {});
        // 客户端中途断开时取消 agent，避免空跑继续计费。
        if (cancel) {
          void cancelAiChatSessionRequest(
            sessionId,
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
        model: body.model,
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
              writeChunk({
                id: chunkId,
                object: 'chat.completion.chunk',
                created,
                model: body.model,
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
            // 终止 chunk：空 delta + finish_reason。
            writeChunk({
              id: chunkId,
              object: 'chat.completion.chunk',
              created,
              model: body.model,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            });
            // 可选 usage chunk（仅当客户端 stream_options.include_usage 且有用量；usage 已归一化）。
            if (includeUsage && event.usage) {
              writeChunk({
                id: chunkId,
                object: 'chat.completion.chunk',
                created,
                model: body.model,
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
        userMessage: lastUser.content,
        inputKind: pastedBoard ? 'user_pasted_board' : 'normal',
        pastedBoard,
        history: [],
        sessionId,
        personaPrompt: systemPrompt,
        authorizedSkillBundleIds,
        llmRuntime: runtime,
        entitlementSnapshot: entitlement,
        waitForResponse: false,
      }).catch((err) => {
        request.log.error({ err, sessionId }, '开放 API 流式分发失败');
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

    const result = await dispatchAiChatPrompt({
      accountId,
      userMessage: lastUser.content,
      inputKind: pastedBoard ? 'user_pasted_board' : 'normal',
      pastedBoard,
      history: [], // 对外单轮调用，不携带历史（多轮历史映射见设计文档）。
      sessionId,
      personaPrompt: systemPrompt,
      authorizedSkillBundleIds,
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

    // 真实 token 用量由 dispatchAiChatPrompt 经 IPC 回传（result.usage，归一化口径、与计费一致）；
    // provider 未上报时回退 0。
    const usage = result.usage;
    return {
      id: `chatcmpl-${result.requestId}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model,
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
}
