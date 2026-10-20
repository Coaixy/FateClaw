import {
  VISUALIZATION_RPC_TIMEOUT_MS,
  isVisualizationIpcRequest,
  visualizationResponseQueue,
  type VisualizationResult,
} from '@fateclaw/contracts/agent/visualization';

import { getRedis } from '#infrastructure/redis';
import { logger } from '#infrastructure/logger';
import { InactiveConversationRequestError } from '#infrastructure/repositories/conversation-tool-repository';
import { executeConversationVisualization } from '#modules/chat/conversation-visualization-service';
import { publishAiChatStreamEvent } from './ai-chat-stream.js';
import { encodeRuntimeIpc } from './ipc-security.js';

export async function processVisualizationToolPayload(
  payload: unknown,
  accountId: string,
): Promise<void> {
  if (!isVisualizationIpcRequest(payload))
    throw new Error('Invalid visualization tool request');
  let result: VisualizationResult;
  try {
    result = await executeConversationVisualization(accountId, payload);
  } catch (error) {
    if (error instanceof InactiveConversationRequestError)
      result = {
        ok: false,
        code: 'VISUALIZATION.REQUEST_INACTIVE',
        error: error.message,
      };
    else {
      logger.error(
        {
          accountId,
          requestId: payload.requestId,
          errorType: error instanceof Error ? error.name : 'unknown',
        },
        'Conversation visualization failed',
      );
      result = {
        ok: false,
        code: 'VISUALIZATION.UNAVAILABLE',
        error: '图形服务暂时不可用，请用文字继续回答',
      };
    }
  }
  if (result.ok) {
    // The committed message remains authoritative if the live notification is lost.
    await publishAiChatStreamEvent({
      sessionId: result.sessionId,
      event: {
        type: 'message',
        accountId,
        sessionId: result.sessionId,
        requestId: payload.requestId,
        timestamp: result.createdAt,
        text: result.artifact.summary,
        metadata: {
          kind: 'visualization_result',
          request_id: payload.requestId,
        },
      },
    }).catch(() => {
      logger.warn(
        { accountId, requestId: payload.requestId },
        'Saved visualization stream notification failed',
      );
    });
  }
  const queue = visualizationResponseQueue(accountId, payload.rpcId);
  const envelope = encodeRuntimeIpc(
    accountId,
    queue,
    JSON.stringify({ rpcId: payload.rpcId, result }),
    VISUALIZATION_RPC_TIMEOUT_MS,
  );
  const replies = await getRedis()
    .multi()
    .lpush(queue, envelope)
    .expire(queue, 30)
    .exec();
  const failure = replies?.find(([error]) => error)?.[0];
  if (!replies || failure)
    throw failure ?? new Error('Visualization reply was not committed');
}
