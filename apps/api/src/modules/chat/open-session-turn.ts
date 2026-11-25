import { randomUUID } from 'node:crypto';
import type { SessionBoardContext } from '@fateclaw/contracts/agent';
import {
  findOpenSessionByIdForUser,
  storeMessage,
  touchOpenSessionActivity,
} from '#infrastructure/db';
import { logger } from '#infrastructure/logger';
import type { OpenSessionRow } from '#infrastructure/repositories/open-sessions-repository';
import { getRuntimeEntitlementSnapshot } from '#modules/billing/entitlements';
import { resolveOfficialLlmRuntime } from '#modules/system/system-config';
import { dispatchAiChatPrompt } from '#runtime/resident-agent';
import {
  claimOrRefreshSessionProcessingLock,
  releaseSessionProcessingLock,
} from '#runtime/session-processing-lock';
import { getWebChatRuntimeId, WEB_CHAT_USER_NAME } from './web-chat-runtime.js';

const SESSION_PROCESSING_TTL_SECONDS = 2100;

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

export async function runOpenSessionTurn(input: {
  userId: string;
  sessionId: string;
  content: string;
}) {
  const { userId, sessionId, content } = input;
  const session = await findOpenSessionByIdForUser(sessionId, userId);
  if (!session) return { status: 'session_not_found' } as const;

  const runtime = await resolveOfficialLlmRuntime();
  if (!runtime) return { status: 'model_not_found' } as const;

  const entitlement = await getRuntimeEntitlementSnapshot(userId);
  const accountId = getWebChatRuntimeId(userId);
  const runtimeSessionId = session.runtime_session_id;
  const sessionBoardContexts = buildSessionBoardContexts(session);
  const requestId = randomUUID();
  const lockClaimed = await claimOrRefreshSessionProcessingLock(
    runtimeSessionId,
    requestId,
    SESSION_PROCESSING_TTL_SECONDS,
  );
  if (!lockClaimed) return { status: 'session_busy' } as const;

  try {
    // Preserve the user input for the usage detail view, even when dispatch fails.
    await storeMessage({
      id: randomUUID(),
      account_id: accountId,
      user_id: userId,
      sender: userId,
      sender_name: WEB_CHAT_USER_NAME,
      content,
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
      session_id: runtimeSessionId,
    }).catch((err) => {
      logger.warn(
        { err, sessionId },
        '对外会话用户消息持久化失败（不影响本轮回复）',
      );
    });

    const result = await dispatchAiChatPrompt({
      accountId,
      userMessage: content,
      history: [],
      sessionBoardContexts,
      sessionId: runtimeSessionId,
      requestId,
      personaPrompt: session.persona_prompt ?? undefined,
      // An empty array explicitly opts out of loading the user's skills.
      authorizedSkillIds: session.authorized_skill_ids ?? [],
      llmRuntime: runtime,
      entitlementSnapshot: entitlement,
      waitForResponse: true,
    });

    if (result.status === 'error') {
      return {
        status: 'agent_error',
        message: result.publicErrorText ?? result.error ?? 'Agent 执行失败',
        code: result.publicReasonCode ?? 'agent_error',
      } as const;
    }

    void touchOpenSessionActivity(sessionId, userId).catch(() => {});
    return {
      status: 'success',
      result,
      providerKey: runtime.providerKey,
    } as const;
  } catch (err) {
    logger.error({ err, sessionId }, '对外会话发消息失败');
    return {
      status: 'agent_error',
      message: 'AI 服务暂时不可用，请稍后重试',
      code: 'agent_error',
    } as const;
  } finally {
    void releaseSessionProcessingLock(runtimeSessionId, requestId).catch(
      () => {},
    );
  }
}
