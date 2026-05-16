import type { AgentRuntimeDeps } from '../deps.js';
import {
  canSendIntermediateMessage,
  canSendOutbound,
  getRequestId,
  incrementOutbound,
  incrementSendMessage,
} from '../request-scope.js';
import type { RequestScope } from '../request-scope.js';
import { throwIfAborted } from '../timeout.js';
import { traceEvent } from '../trace.js';

export async function sendAssistantIntermediateText(args: {
  accountId: string;
  text: string;
  requestScope: RequestScope;
  runtimeDeps: AgentRuntimeDeps;
  provider: string;
  iteration: number;
  sentTexts: Set<string>;
  signal?: AbortSignal;
}): Promise<void> {
  const text = args.text.trim();
  if (!text || args.sentTexts.has(text)) return;
  if (
    !canSendOutbound(args.requestScope) ||
    !canSendIntermediateMessage(args.requestScope)
  ) {
    traceEvent(
      {
        type: 'assistant_intermediate_skipped',
        provider: args.provider,
        iteration: args.iteration,
        reason: 'message_limit',
        textLength: text.length,
      },
      args.requestScope,
    );
    return;
  }

  try {
    throwIfAborted(args.signal, 'assistant 中间消息已取消');
    await args.runtimeDeps.messageBus.pushOutbox(args.accountId, {
      type: 'message',
      accountId: args.accountId,
      requestId: getRequestId(args.requestScope),
      text,
      timestamp: new Date().toISOString(),
    });
    args.sentTexts.add(text);
    incrementOutbound(args.requestScope);
    incrementSendMessage(args.requestScope);
    traceEvent(
      {
        type: 'assistant_intermediate_message',
        provider: args.provider,
        iteration: args.iteration,
        textLength: text.length,
      },
      args.requestScope,
    );
  } catch (error) {
    traceEvent(
      {
        type: 'assistant_intermediate_message_error',
        provider: args.provider,
        iteration: args.iteration,
        error: error instanceof Error ? error.message : String(error),
      },
      args.requestScope,
    );
  }
}
