import type { AiChatStreamEvent } from './types.js';
import { getRedis } from './redis.js';

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
    JSON.stringify(args.event),
  );
}
