import { describe, expect, it } from 'vitest';

import { shouldPollChatMessages } from '@/features/chat/utils/polling';

describe('chat polling cadence', () => {
  it('reconciles initially and periodically even with continuous stream progress', () => {
    expect(
      shouldPollChatMessages({
        now: 0,
        lastPollAt: null,
        lastProgressAt: 0,
        streamConnected: true,
      }),
    ).toBe(true);
    const polls: number[] = [];
    let lastPollAt = 0;
    for (let now = 1_200; now <= 60_000; now += 1_200) {
      if (
        shouldPollChatMessages({
          now,
          lastPollAt,
          lastProgressAt: now,
          streamConnected: true,
        })
      ) {
        polls.push(now);
        lastPollAt = now;
      }
    }
    expect(polls).toEqual([15_600, 31_200, 46_800]);
  });

  it('falls back when business progress stops, without waiting for reconciliation', () => {
    const input = { lastPollAt: 0, lastProgressAt: 0, streamConnected: true };
    expect(shouldPollChatMessages({ ...input, now: 4_800 })).toBe(false);
    expect(shouldPollChatMessages({ ...input, now: 5_000 })).toBe(true);
  });

  it('uses fast polling on disconnect even after recent progress', () => {
    expect(
      shouldPollChatMessages({
        now: 1_200,
        lastPollAt: 0,
        lastProgressAt: 1_000,
        streamConnected: false,
      }),
    ).toBe(true);
  });

  it('does not treat a fresh handshake as business progress', () => {
    expect(
      shouldPollChatMessages({
        now: 1_200,
        lastPollAt: 0,
        lastProgressAt: null,
        streamConnected: true,
      }),
    ).toBe(true);
  });

  it('returns to reduced polling after stream recovery but limits fallback retries', () => {
    const input = {
      now: 6_000,
      lastPollAt: 5_000,
      lastProgressAt: 0,
      streamConnected: false,
    };
    expect(shouldPollChatMessages(input)).toBe(false);
    expect(shouldPollChatMessages({ ...input, now: 6_200 })).toBe(true);
    expect(
      shouldPollChatMessages({
        ...input,
        now: 6_200,
        lastProgressAt: 6_200,
        streamConnected: true,
      }),
    ).toBe(false);
  });
});
