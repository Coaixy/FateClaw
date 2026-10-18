import {
  InvalidRuntimeIpcError,
  openRuntimeIpc,
  sealRuntimeIpc,
} from '@fateclaw/contracts/runtime-ipc';

function ipcKey(): string {
  const key = process.env.FATECLAW_IPC_KEY;
  if (!key) throw new InvalidRuntimeIpcError();
  return key;
}

export function encodeAgentIpc(
  channel: string,
  raw: string,
  lifetimeMs?: number,
): string {
  return sealRuntimeIpc(raw, channel, ipcKey(), lifetimeMs);
}

export function decodeAgentIpc(channel: string, raw: string): string {
  return openRuntimeIpc(raw, channel, ipcKey());
}
