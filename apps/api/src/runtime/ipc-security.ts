import {
  deriveRuntimeIpcKey,
  openRuntimeIpc,
  sealRuntimeIpc,
} from '@fateclaw/contracts/runtime-ipc';
import { JWT_SECRET } from '#infrastructure/config';

export function runtimeIpcKey(accountId: string): string {
  return deriveRuntimeIpcKey(JWT_SECRET, `account:${accountId}`);
}

export function encodeRuntimeIpc(
  accountId: string,
  channel: string,
  raw: string,
  lifetimeMs?: number,
): string {
  return sealRuntimeIpc(raw, channel, runtimeIpcKey(accountId), lifetimeMs);
}

export function decodeRuntimeIpc(
  accountId: string,
  channel: string,
  raw: string,
  allowExpired = false,
): string {
  return openRuntimeIpc(raw, channel, runtimeIpcKey(accountId), allowExpired);
}

export function encodeControlIpc(
  purpose: string,
  channel: string,
  raw: string,
  lifetimeMs: number,
): string {
  return sealRuntimeIpc(
    raw,
    channel,
    deriveRuntimeIpcKey(JWT_SECRET, `control:${purpose}`),
    lifetimeMs,
  );
}

export function decodeControlIpc(
  purpose: string,
  channel: string,
  raw: string,
): string {
  return openRuntimeIpc(
    raw,
    channel,
    deriveRuntimeIpcKey(JWT_SECRET, `control:${purpose}`),
  );
}
