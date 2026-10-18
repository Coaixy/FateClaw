import type { AiChatStreamEvent } from './types.js';
import { getRedis } from './redis.js';
import { encodeAgentIpc } from './ipc-security.js';

type TextStreamEvent = Extract<
  AiChatStreamEvent,
  { type: 'assistant_delta' | 'thinking_delta' }
>;

export function createAiChatStreamPublisher(
  publish: (event: AiChatStreamEvent) => void,
): { publish: (event: AiChatStreamEvent) => void; close: () => void } {
  let pending: TextStreamEvent | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  function flush(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const event = pending;
    pending = undefined;
    if (event) publish(event);
  }

  return {
    publish(event) {
      if (closed) return;
      if (event.type !== 'assistant_delta' && event.type !== 'thinking_delta') {
        // Boundaries must follow the last text snapshot, even within a batch window.
        flush();
        publish(event);
        return;
      }
      if (
        pending &&
        (pending.type !== event.type ||
          pending.turnIndex !== event.turnIndex ||
          !event.snapshot.startsWith(pending.snapshot))
      ) {
        flush();
      }
      pending = pending
        ? { ...event, delta: pending.delta + event.delta }
        : event;
      if (timer === undefined) {
        timer = setTimeout(flush, 50);
        timer.unref();
      }
    },
    close() {
      closed = true;
      flush();
    },
  };
}

export function aiChatStreamChannel(sessionId: string): string {
  return `ipc:ai-chat:stream:${sessionId}`;
}

export function enrichAiChatStreamEvent(args: {
  event: AiChatStreamEvent;
  requestId?: string;
  accountId: string;
  sessionId?: string;
}): AiChatStreamEvent {
  return {
    timestamp: new Date().toISOString(),
    requestId: args.requestId,
    accountId: args.accountId,
    sessionId: args.sessionId,
    ...args.event,
  } as AiChatStreamEvent;
}

export async function publishAiChatStreamEvent(args: {
  sessionId?: string;
  event: AiChatStreamEvent;
}): Promise<void> {
  if (!args.sessionId) return;
  await getRedis().publish(
    aiChatStreamChannel(args.sessionId),
    encodeAgentIpc(
      aiChatStreamChannel(args.sessionId),
      JSON.stringify(args.event),
      60_000,
    ),
  );
}

export async function pushAiChatOutboxMessage(args: {
  outboxQueue?: string;
  message: unknown;
}): Promise<void> {
  if (!args.outboxQueue) return;
  await getRedis().lpush(
    args.outboxQueue,
    encodeAgentIpc(args.outboxQueue, JSON.stringify(args.message)),
  );
}
