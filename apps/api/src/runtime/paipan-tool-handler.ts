import {
  PAIPAN_RPC_TIMEOUT_MS,
  isPaipanIpcRequest,
  paipanResponseQueue,
  type PaipanResult,
} from '@fateclaw/contracts/agent/paipan';

import { getRedis } from '#infrastructure/redis';
import { logger } from '#infrastructure/logger';
import { InactivePaipanRequestError } from '#infrastructure/repositories/conversation-paipan-repository';
import { executeConversationPaipan } from '#modules/chat/conversation-paipan-service';
import { DirectPaipanError } from '#modules/chat/paipan-runtime';
import { publishAiChatStreamEvent } from './ai-chat-stream.js';
import { encodeRuntimeIpc } from './ipc-security.js';

export async function processPaipanToolPayload(
  payload: unknown,
  accountId: string,
): Promise<void> {
  if (!isPaipanIpcRequest(payload))
    throw new Error('Invalid paipan tool request');
  let result: PaipanResult;
  try {
    result = await executeConversationPaipan(accountId, payload);
  } catch (error) {
    if (error instanceof DirectPaipanError) {
      result = { ok: false, code: error.code, error: error.message };
    } else if (error instanceof InactivePaipanRequestError) {
      result = {
        ok: false,
        code: 'PAIPAN.REQUEST_INACTIVE',
        error: error.message,
      };
    } else {
      logger.error(
        {
          accountId,
          requestId: payload.requestId,
          errorType: error instanceof Error ? error.name : 'unknown',
        },
        'Conversation paipan failed',
      );
      result = {
        ok: false,
        code: 'PAIPAN.UNAVAILABLE',
        error: '起盘服务暂时不可用，请稍后重试',
      };
    }
  }
  if (result.ok && result.mode === 'create') {
    // Persistence has committed; stream failure must not invalidate a saved chart.
    await publishAiChatStreamEvent({
      sessionId: result.sessionId,
      event: {
        type: 'message',
        accountId,
        sessionId: result.sessionId,
        requestId: payload.requestId,
        timestamp: result.board.createdAt,
        text: `已生成${result.board.artifactTitle || result.board.skill}。`,
        metadata: {
          kind: 'board_result',
          workflow: 'conversation_paipan',
          request_id: payload.requestId,
          board_skill: result.board.skill,
        },
      },
    }).catch(() => {
      logger.warn(
        { accountId, requestId: payload.requestId },
        'Saved paipan stream notification failed',
      );
    });
  }
  const replyQueue = paipanResponseQueue(accountId, payload.rpcId);
  const envelope = encodeRuntimeIpc(
    accountId,
    replyQueue,
    JSON.stringify({ rpcId: payload.rpcId, result }),
    PAIPAN_RPC_TIMEOUT_MS,
  );
  const replies = await getRedis()
    .multi()
    .lpush(replyQueue, envelope)
    .expire(replyQueue, 30)
    .exec();
  const failure = replies?.find(([error]) => error)?.[0];
  if (!replies || failure)
    throw failure ?? new Error('Paipan reply was not committed');
}
