import type { Message } from '../api';

export type ChatRunPhase =
  | 'idle'
  | 'queued'
  | 'running'
  | 'syncing'
  | 'stopping'
  | 'completed'
  | 'stopped'
  | 'failed';

export interface ChatRunState {
  sessionId: string;
  requestId: string | null;
  phase: ChatRunPhase;
  error: string | null;
}

export function getChatTurnOutcome(
  messages: Message[],
  requestId?: string | null,
  knownBeforeSubmission?: ReadonlySet<string>,
): 'completed' | 'failed' | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message.is_bot_message) return null;
    if (knownBeforeSubmission?.has(message.id)) continue;
    if (requestId && message.metadata?.request_id !== requestId) continue;
    if (message.metadata?.kind === 'error') return 'failed';
    if (message.metadata?.kind === 'final') return 'completed';
  }
  return null;
}

export function acceptsChatStreamRequest(
  activeRequestId: string | null,
  incomingRequestId?: string,
) {
  return (
    !activeRequestId ||
    !incomingRequestId ||
    activeRequestId === incomingRequestId
  );
}
