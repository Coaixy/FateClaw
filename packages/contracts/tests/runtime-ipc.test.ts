import { describe, expect, it, vi } from 'vitest';
import {
  deriveRuntimeIpcKey,
  InvalidRuntimeIpcError,
  openRuntimeIpc,
  sealRuntimeIpc,
} from '../src/runtime-ipc/index.js';

const key = deriveRuntimeIpcKey('synthetic-root-secret', 'web:user-1');
const channel = 'ipc:web:user-1:inbox';
const raw = JSON.stringify({
  requestId: 'request-1',
  accountId: 'web:user-1',
  apiKey: 'synthetic-provider-secret',
});

describe('authenticated runtime transport', () => {
  it('keeps credentials opaque in Redis while retaining an event identity for retries', () => {
    const wire = sealRuntimeIpc(raw, channel, key);
    expect(wire).not.toContain('synthetic-provider-secret');
    const decoded = JSON.parse(openRuntimeIpc(wire, channel, key));
    expect(decoded).toMatchObject(JSON.parse(raw));
    expect(decoded.eventId).toEqual(expect.any(String));
    expect(openRuntimeIpc(wire, channel, key)).toBe(
      openRuntimeIpc(wire, channel, key),
    );
  });

  it('rejects another account key and copying an inbox envelope into an outbox', () => {
    const wire = sealRuntimeIpc(raw, channel, key);
    expect(() =>
      openRuntimeIpc(
        wire,
        channel,
        deriveRuntimeIpcKey('synthetic-root-secret', 'web:user-2'),
      ),
    ).toThrow(InvalidRuntimeIpcError);
    expect(() => openRuntimeIpc(wire, 'ipc:web:user-1:outbox', key)).toThrow(
      InvalidRuntimeIpcError,
    );
  });

  it('rejects plaintext and tampered authentication metadata', () => {
    expect(() => openRuntimeIpc(raw, channel, key)).toThrow(
      InvalidRuntimeIpcError,
    );
    const envelope = JSON.parse(sealRuntimeIpc(raw, channel, key));
    envelope.expiresAt -= 1;
    expect(() =>
      openRuntimeIpc(JSON.stringify(envelope), channel, key),
    ).toThrow(InvalidRuntimeIpcError);
    expect(() =>
      openRuntimeIpc(
        JSON.stringify({ ...envelope, tag: 'a'.repeat(22) }),
        channel,
        key,
      ),
    ).toThrow(InvalidRuntimeIpcError);
  });

  it('rejects expired work while allowing authenticated retirement of its transport copy', () => {
    vi.useFakeTimers();
    try {
      const wire = sealRuntimeIpc(raw, channel, key, 1000);
      vi.advanceTimersByTime(1001);
      expect(() => openRuntimeIpc(wire, channel, key)).toThrow(
        InvalidRuntimeIpcError,
      );
      expect(
        JSON.parse(openRuntimeIpc(wire, channel, key, true)),
      ).toMatchObject(JSON.parse(raw));
    } finally {
      vi.useRealTimers();
    }
  });
});
