import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { PI_THINKING_LEVELS } from '../../shared/types.js';
import { dispatchAiChatPrompt } from '../../runtime/resident-agent.js';
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
      // TODO(stream): 真流式需 dispatch(waitForResponse:false) + 订阅 aiChatStreamChannel(sessionId)，
      //   把 assistant_delta 翻译成 OpenAI chunk（data: {...}）并以 data: [DONE] 收尾。
      //   MVP 暂未实现，返回 501 而非给出对不上的流式契约。
      return sendOpenAiError(
        reply,
        501,
        '流式响应尚未实现（开发中）',
        'api_error',
        'stream_not_implemented',
      );
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

    // TODO(usage): InboxRequestResult 不直接含 token usage 数字（在内部结算用，可能在 metadata）。
    //   精确 usage 需从 result.metadata 或会话日志取；此处先置 0 占位。
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
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  });
}
