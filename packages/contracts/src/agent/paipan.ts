import type { PaipanCatalogItemDto } from '../chat/index.js';
import type { SessionBoardContext } from './index.js';

export const PAIPAN_RPC_TIMEOUT_MS = 15_000;

export type PaipanOperation =
  | { mode: 'catalog'; skill?: string }
  | {
      mode: 'create';
      skill: string;
      input: Record<string, unknown>;
      toolCallId: string;
    };

export interface PaipanIpcRequest {
  rpcId: string;
  requestId: string;
  executionId: string;
  operation: PaipanOperation;
}

export type PaipanResult =
  | { ok: true; mode: 'catalog'; catalog: PaipanCatalogItemDto[] }
  | { ok: true; mode: 'create'; sessionId: string; board: SessionBoardContext }
  | { ok: false; code: string; error: string };

export type PaipanCaller = (
  operation: PaipanOperation,
  signal?: AbortSignal,
) => Promise<PaipanResult>;

export function paipanRequestQueue(accountId: string): string {
  return `ipc:${accountId}:paipan`;
}

export function paipanResponseQueue(accountId: string, rpcId: string): string {
  return `ipc:${accountId}:paipan:reply:${rpcId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

export function isPaipanIpcRequest(value: unknown): value is PaipanIpcRequest {
  if (!isRecord(value)) return false;
  if (
    typeof value.rpcId !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(value.rpcId) ||
    !isIdentifier(value.requestId) ||
    !isIdentifier(value.executionId) ||
    !isRecord(value.operation)
  )
    return false;
  const operation = value.operation;
  if (operation.mode === 'catalog') {
    return operation.skill === undefined || isIdentifier(operation.skill);
  }
  return (
    operation.mode === 'create' &&
    isIdentifier(operation.skill) &&
    isIdentifier(operation.toolCallId) &&
    isRecord(operation.input)
  );
}
