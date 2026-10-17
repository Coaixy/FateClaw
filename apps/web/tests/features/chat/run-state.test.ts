import { describe, expect, it } from 'vitest';
import type { Message } from '@/features/chat/api';
import {
  acceptsChatStreamRequest,
  getChatTurnOutcome,
} from '@/features/chat/utils/run-state';

const base: Message = {
  id: 'reply',
  account_id: 'web:synthetic-user',
  sender: 'assistant',
  sender_name: 'AI',
  content: 'Synthetic response',
  timestamp: '2026-10-17T00:00:00.000Z',
  is_from_me: true,
  is_bot_message: true,
};

describe('chat run outcome', () => {
  it('distinguishes failed and completed results and waits for a final result after the latest user', () => {
    const error = {
      ...base,
      metadata: { kind: 'error', request_id: 'request-1' },
    };
    const final = {
      ...base,
      metadata: { kind: 'final', request_id: 'request-1' },
    };
    expect(getChatTurnOutcome([error], 'request-1')).toBe('failed');
    expect(getChatTurnOutcome([final], 'request-1')).toBe('completed');
    expect(
      getChatTurnOutcome(
        [final, { ...base, id: 'next-user', is_bot_message: false }],
        'request-1',
      ),
    ).toBeNull();
    expect(getChatTurnOutcome([final], 'request-2')).toBeNull();
    expect(
      getChatTurnOutcome(
        [{ ...base, metadata: { kind: 'final' } }],
        'request-1',
      ),
    ).toBeNull();
    expect(getChatTurnOutcome([final], null, new Set([final.id]))).toBeNull();
  });

  it('rejects delayed events from a previous request while preserving initial stream discovery', () => {
    expect(acceptsChatStreamRequest('current', 'previous')).toBe(false);
    expect(acceptsChatStreamRequest('current', 'current')).toBe(true);
    expect(acceptsChatStreamRequest(null, 'current')).toBe(true);
  });
});
