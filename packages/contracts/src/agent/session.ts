import { createHash } from 'node:crypto';
import type {
  PiSessionBase,
  PiSessionFrame,
  PiSessionSnapshot,
} from './index.js';

export const PI_SESSION_CHECKPOINT_INTERVAL = 16;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

// JSONB changes object key order; hashes must survive a database round trip.
export function hashPiMessages(messages: unknown[]): string {
  const hash = createHash('sha256');
  for (const message of messages)
    hash.update(JSON.stringify(canonical(message))).update('\n');
  return hash.digest('hex');
}

export function isPiSessionFrame(value: unknown): value is PiSessionFrame {
  if (!value || typeof value !== 'object') return false;
  const frame = value as PiSessionFrame;
  return (
    frame.format === 'fateclaw-pi-frame-v1' &&
    (frame.kind === 'checkpoint' || frame.kind === 'delta') &&
    Array.isArray(frame.messages) &&
    Number.isSafeInteger(frame.messageCount) &&
    frame.messageCount >= 0 &&
    typeof frame.messagesHash === 'string' &&
    /^[a-f0-9]{64}$/.test(frame.messagesHash) &&
    Number.isSafeInteger(frame.checkpointDepth) &&
    frame.checkpointDepth >= 0 &&
    frame.checkpointDepth < PI_SESSION_CHECKPOINT_INTERVAL
  );
}

export function createPiSessionFrame(
  snapshot: PiSessionSnapshot,
  base?: PiSessionBase,
): PiSessionFrame {
  const delta =
    base &&
    base.checkpointDepth < PI_SESSION_CHECKPOINT_INTERVAL - 1 &&
    base.messageCount <= snapshot.messages.length &&
    hashPiMessages(snapshot.messages.slice(0, base.messageCount)) ===
      base.messagesHash;
  return {
    ...snapshot,
    format: 'fateclaw-pi-frame-v1',
    kind: delta ? 'delta' : 'checkpoint',
    ...(delta ? { base } : {}),
    messages: delta
      ? snapshot.messages.slice(base.messageCount)
      : snapshot.messages,
    messagesHash: hashPiMessages(snapshot.messages),
    checkpointDepth: delta ? base.checkpointDepth + 1 : 0,
  };
}

export function restorePiSessionFrame(
  frame: PiSessionFrame,
  base?: PiSessionSnapshot,
): PiSessionSnapshot {
  if (!isPiSessionFrame(frame)) throw new Error('Invalid Pi session frame');
  if (
    frame.kind === 'delta' &&
    (!base ||
      !frame.base ||
      base.messages.length !== frame.base.messageCount ||
      hashPiMessages(base.messages) !== frame.base.messagesHash)
  )
    throw new Error('Pi session frame base does not match');
  const messages =
    frame.kind === 'delta'
      ? [...base!.messages, ...frame.messages]
      : frame.messages;
  if (
    messages.length !== frame.messageCount ||
    hashPiMessages(messages) !== frame.messagesHash
  )
    throw new Error('Pi session frame integrity check failed');
  const {
    format: _format,
    kind: _kind,
    base: _base,
    messagesHash: _hash,
    checkpointDepth: _depth,
    ...snapshot
  } = frame;
  return { ...snapshot, messages };
}
