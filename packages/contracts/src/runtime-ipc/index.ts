import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';

export class InvalidRuntimeIpcError extends Error {
  constructor() {
    super('Invalid or expired runtime IPC envelope');
  }
}

/** The host retains the root secret; each child receives only its own derived key. */
export function deriveRuntimeIpcKey(root: string, accountId: string): string {
  return Buffer.from(
    hkdfSync('sha256', root, 'fateclaw/runtime-ipc/v1', accountId, 32),
  ).toString('hex');
}

function keyBytes(key: string): Buffer {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new InvalidRuntimeIpcError();
  return Buffer.from(key, 'hex');
}

export function sealRuntimeIpc(
  raw: string,
  channel: string,
  key: string,
  lifetimeMs = 86_400_000,
): string {
  const payload = JSON.parse(raw);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new InvalidRuntimeIpcError();
  const expiresAt = Date.now() + Math.min(86_400_000, Math.max(1, lifetimeMs));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(key), iv);
  cipher.setAAD(Buffer.from(JSON.stringify([1, channel, expiresAt])));
  const data = Buffer.concat([
    cipher.update(
      JSON.stringify({ ...payload, eventId: payload.eventId ?? randomUUID() }),
      'utf8',
    ),
    cipher.final(),
  ]);
  return JSON.stringify({
    version: 1,
    expiresAt,
    iv: iv.toString('base64url'),
    data: data.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
  });
}

export function openRuntimeIpc(
  raw: string,
  channel: string,
  key: string,
  allowExpired = false,
): string {
  try {
    const envelope = JSON.parse(raw);
    if (
      !envelope ||
      envelope.version !== 1 ||
      !Number.isSafeInteger(envelope.expiresAt) ||
      (!allowExpired && envelope.expiresAt <= Date.now()) ||
      envelope.expiresAt > Date.now() + 86_400_000 ||
      typeof envelope.iv !== 'string' ||
      typeof envelope.data !== 'string' ||
      typeof envelope.tag !== 'string'
    )
      throw new InvalidRuntimeIpcError();
    const iv = Buffer.from(envelope.iv, 'base64url');
    const tag = Buffer.from(envelope.tag, 'base64url');
    if (iv.length !== 12 || tag.length !== 16)
      throw new InvalidRuntimeIpcError();
    const decipher = createDecipheriv('aes-256-gcm', keyBytes(key), iv, {
      authTagLength: 16,
    });
    decipher.setAAD(
      Buffer.from(JSON.stringify([1, channel, envelope.expiresAt])),
    );
    decipher.setAuthTag(tag);
    // Do not expose plaintext until authentication succeeds at final().
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new InvalidRuntimeIpcError();
  }
}
