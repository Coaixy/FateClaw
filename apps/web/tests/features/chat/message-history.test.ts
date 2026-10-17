import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@/features/chat/api';
import {
  fetchRecentMessageWindow,
  reconcileMessagePage,
} from '@/features/chat/utils/message-history';

function message(index: number): Message {
  return {
    id: `message-${String(index).padStart(4, '0')}`,
    content: `Message ${index}`,
    timestamp: new Date(Date.UTC(2026, 9, 17, 0, 0, index)).toISOString(),
    account_id: 'web:user-1',
    sender: 'assistant',
    sender_name: 'AI',
    is_from_me: true,
    is_bot_message: true,
    metadata: { kind: 'final' },
  };
}

describe('chat history reconciliation', () => {
  it('retains expanded history beyond the API cap and replaces only changed tail values', () => {
    const previous = Array.from({ length: 250 }, (_, index) => message(index));
    const refreshed = previous.slice(-50).map((value) => ({ ...value }));
    refreshed[49] = {
      ...refreshed[49],
      metadata: { kind: 'final', actual_charge_coins: 3 },
    };
    const result = reconcileMessagePage(previous, refreshed);

    expect(result).toHaveLength(250);
    expect(result[0]).toBe(previous[0]);
    expect(result[200]).toBe(previous[200]);
    expect(result[249].metadata?.actual_charge_coins).toBe(3);
    expect(reconcileMessagePage(result, [])).toBe(result);
  });

  it('backfills a disconnected stream before merging the latest page', async () => {
    const previous = Array.from({ length: 250 }, (_, index) => message(index));
    const all = [
      ...previous,
      ...Array.from({ length: 120 }, (_, index) => message(index + 250)),
    ];
    const readPage = vi.fn(async (before?: string) => ({
      messages: all
        .filter((value) => !before || value.timestamp < before)
        .slice(-50)
        .reverse(),
      processing: false,
    }));
    const result = await fetchRecentMessageWindow(readPage, previous);

    expect(readPage).toHaveBeenCalledTimes(3);
    expect(
      reconcileMessagePage(previous, [...result.messages].reverse()).map(
        (value) => value.id,
      ),
    ).toEqual(all.map((value) => value.id));
  });

  it('uses an ID cursor when new messages share the last known timestamp', async () => {
    const timestamp = '2026-10-17T00:00:00.000Z';
    const all = Array.from({ length: 130 }, (_, index) => ({
      ...message(index),
      timestamp,
    }));
    const previous = all.slice(0, 20);
    const readPage = vi.fn(async (_before?: string, beforeId?: string) => ({
      messages: all
        .filter((value) => !beforeId || value.id < beforeId)
        .slice(-50)
        .reverse(),
      processing: false,
    }));
    const result = await fetchRecentMessageWindow(readPage, previous);

    expect(readPage).toHaveBeenCalledTimes(3);
    expect(readPage.mock.calls[1]).toEqual([timestamp, all[80].id]);
    expect(
      reconcileMessagePage(previous, [...result.messages].reverse()).map(
        (value) => value.id,
      ),
    ).toEqual(all.map((value) => value.id));
  });

  it('ends an excessive reconciliation explicitly instead of silently dropping the gap', async () => {
    let index = 5000;
    const readPage = vi.fn(async () => ({
      messages: Array.from({ length: 50 }, () => message(index--)),
      processing: true,
    }));
    await expect(
      fetchRecentMessageWindow(readPage, [message(0)]),
    ).rejects.toThrow('同步未完成');
    expect(readPage).toHaveBeenCalledTimes(20);
  });
});
