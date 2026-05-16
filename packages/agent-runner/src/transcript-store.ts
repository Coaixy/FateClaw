import type { TranscriptEvent } from './types.js';
import type { RequestScope } from './request-scope.js';

export function appendTranscriptEvent(
  scope: RequestScope,
  event: TranscriptEvent,
): TranscriptEvent {
  scope.transcript.push(event);
  return event;
}

export function listTranscriptEvents(scope: RequestScope): TranscriptEvent[] {
  return [...scope.transcript];
}
