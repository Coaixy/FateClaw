import type { SessionMessageListResponseDto } from '@fateclaw/contracts/chat';
import type { Message } from '../api';
import { areMessageValuesEqual } from './display';

export const CHAT_MESSAGE_PAGE_SIZE = 50;
const MAX_RECONCILIATION_PAGES = 20;

export function isLocalChatMessage(message: Message) {
  return /^(opt-|stream-bot-|tool-trace-)/.test(message.id);
}

/** Replace the refreshed tail while retaining previously expanded history. */
export function reconcileMessagePage(previous: Message[], incoming: Message[]) {
  if (incoming.length === 0) return previous;
  const previousById = new Map(
    previous.map((message) => [message.id, message]),
  );
  const incomingIds = new Set(incoming.map((message) => message.id));
  const oldestTime = Date.parse(incoming[0].timestamp);
  const prefix = previous.filter(
    (message) =>
      !isLocalChatMessage(message) &&
      !incomingIds.has(message.id) &&
      Date.parse(message.timestamp) <= oldestTime,
  );
  const tail = incoming.map((message) => {
    const existing = previousById.get(message.id);
    return existing && areMessageValuesEqual(existing, message)
      ? existing
      : message;
  });
  return [...prefix, ...tail];
}

/** Backfill a disconnected stream until the refreshed tail overlaps known history. */
export async function fetchRecentMessageWindow(
  readPage: (
    before?: string,
    beforeId?: string,
  ) => Promise<SessionMessageListResponseDto>,
  previous: Message[],
): Promise<SessionMessageListResponseDto> {
  const latest = await readPage();
  let messages = [...latest.messages];
  const known = previous.filter((message) => !isLocalChatMessage(message));
  if (known.length === 0) return latest;
  const knownIds = new Set(known.map((message) => message.id));
  const latestKnownTime = known.reduce(
    (latestTime, message) =>
      Math.max(latestTime, Date.parse(message.timestamp)),
    0,
  );
  let page = latest.messages;

  for (let index = 1; index <= MAX_RECONCILIATION_PAGES; index += 1) {
    const oldest = page[page.length - 1];
    if (
      !oldest ||
      page.length < CHAT_MESSAGE_PAGE_SIZE ||
      messages.some((message) => knownIds.has(message.id)) ||
      Date.parse(oldest.timestamp) < latestKnownTime
    ) {
      return { ...latest, messages };
    }
    if (index === MAX_RECONCILIATION_PAGES) break;
    const older = await readPage(oldest.timestamp, oldest.id);
    const seen = new Set(messages.map((message) => message.id));
    page = older.messages.filter((message) => !seen.has(message.id));
    if (page.length === 0) return { ...latest, messages };
    messages = [...messages, ...page];
  }

  throw new Error('历史消息同步未完成，请重试同步');
}
