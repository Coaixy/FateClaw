import type {
  MemoryHydration,
  MemoryKind,
  MemoryReference,
} from '../memory/index.js';
import {
  MAX_MEMORY_CONTENT_CHARS,
  MAX_MEMORY_HYDRATE_REFERENCES,
  MAX_MEMORY_QUERY_CHARS,
  MAX_MEMORY_SOURCE_PAGE_CHARS,
} from '../memory/index.js';

export const MEMORY_RPC_TIMEOUT_MS = 10_000;

/**
 * Host memory operations available to one admitted request.
 *
 * `prepare` runs at the start of a turn and refreshes authorization after an in-turn mutation.
 * `read` and `search` hydrate immediately so a tool has text within the same model step.
 */
export type MemoryOperation =
  | { mode: 'prepare'; query?: string; references: MemoryReference[] }
  | { mode: 'read'; references: MemoryReference[] }
  | {
      mode: 'search';
      query: string;
      subjectId?: string;
      after?: string;
      before?: string;
      limit?: number;
    }
  | {
      mode: 'remember';
      content: string;
      kind?: MemoryKind;
      subjectId?: string;
      sourceMessageId?: string;
      toolCallId: string;
    }
  | {
      mode: 'update';
      id: string;
      revision: number;
      content: string;
      toolCallId: string;
    }
  | { mode: 'forget'; id: string; revision?: number; toolCallId: string };

export interface MemoryIpcRequest {
  eventId?: string;
  rpcId: string;
  requestId: string;
  executionId: string;
  operation: MemoryOperation;
}

export type MemoryResult =
  | {
      ok: true;
      mode: 'prepare' | 'read' | 'search';
      hydration: MemoryHydration;
    }
  | { ok: true; mode: 'remember' | 'update'; reference: MemoryReference }
  | { ok: true; mode: 'forget'; forgottenId: string }
  | { ok: false; code: string; error: string };

export type MemoryCaller = (
  operation: MemoryOperation,
  signal?: AbortSignal,
) => Promise<MemoryResult>;

export function memoryRequestQueue(accountId: string): string {
  return `ipc:${accountId}:memory`;
}

export function memoryResponseQueue(accountId: string, rpcId: string): string {
  return `ipc:${accountId}:memory:reply:${rpcId}`;
}

const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

/** Rejects calendar dates that Date.parse silently rolls over (for example February 30). */
export function isMemoryIsoInstant(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false;
  const match = ISO_INSTANT.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second = '0'] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day) &&
    Number(hour) <= 23 &&
    Number(minute) <= 59 &&
    Number(second) <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

export function isMemoryReference(value: unknown): value is MemoryReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  return (
    Object.keys(ref).every((key) =>
      ['kind', 'id', 'revision', 'score', 'offset', 'limit'].includes(key),
    ) &&
    (ref.kind === 'item' || ref.kind === 'source') &&
    isIdentifier(ref.id) &&
    isInteger(ref.revision, 1) &&
    (ref.score === undefined ||
      (typeof ref.score === 'number' && Number.isFinite(ref.score))) &&
    (ref.offset === undefined || isInteger(ref.offset, 0)) &&
    (ref.limit === undefined ||
      isInteger(ref.limit, 1, MAX_MEMORY_SOURCE_PAGE_CHARS))
  );
}

function isIdentifier(item: unknown): item is string {
  return (
    typeof item === 'string' &&
    item.trim().length > 0 &&
    item.length <= 256 &&
    !/[\u0000-\u001f]/.test(item)
  );
}

function isInteger(item: unknown, min = 1, max = Number.MAX_SAFE_INTEGER) {
  return (
    typeof item === 'number' &&
    Number.isSafeInteger(item) &&
    item >= min &&
    item <= max
  );
}

function isText(item: unknown, max: number, allowEmpty = false) {
  return (
    typeof item === 'string' &&
    item.length <= max &&
    (allowEmpty || item.trim().length > 0)
  );
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: string[]) {
  return Object.keys(record).every((key) => allowed.includes(key));
}

function optional(
  record: Record<string, unknown>,
  key: string,
  valid: (item: unknown) => boolean,
) {
  return record[key] === undefined || valid(record[key]);
}

function isReferenceList(item: unknown) {
  return (
    Array.isArray(item) &&
    item.length <= MAX_MEMORY_HYDRATE_REFERENCES &&
    item.every(isMemoryReference)
  );
}

export function isMemoryIpcRequest(value: unknown): value is MemoryIpcRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  if (
    !hasOnlyKeys(request, [
      'rpcId',
      'requestId',
      'executionId',
      'operation',
      'eventId',
    ]) ||
    !optional(request, 'eventId', isIdentifier) ||
    typeof request.rpcId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      request.rpcId,
    ) ||
    !isIdentifier(request.requestId) ||
    !isIdentifier(request.executionId) ||
    !request.operation ||
    typeof request.operation !== 'object' ||
    Array.isArray(request.operation)
  )
    return false;
  const operation = request.operation as Record<string, unknown>;
  switch (operation.mode) {
    case 'prepare':
      return (
        hasOnlyKeys(operation, ['mode', 'query', 'references']) &&
        optional(operation, 'query', (item) =>
          isText(item, MAX_MEMORY_QUERY_CHARS, true),
        ) &&
        isReferenceList(operation.references)
      );
    case 'read':
      return (
        hasOnlyKeys(operation, ['mode', 'references']) &&
        isReferenceList(operation.references) &&
        (operation.references as unknown[]).length > 0
      );
    case 'search':
      return (
        hasOnlyKeys(operation, [
          'mode',
          'query',
          'subjectId',
          'after',
          'before',
          'limit',
        ]) &&
        isText(operation.query, MAX_MEMORY_QUERY_CHARS) &&
        optional(operation, 'limit', (item) => isInteger(item, 1, 100)) &&
        optional(operation, 'subjectId', isIdentifier) &&
        optional(operation, 'after', isMemoryIsoInstant) &&
        optional(operation, 'before', isMemoryIsoInstant) &&
        !(
          operation.after &&
          operation.before &&
          Date.parse(String(operation.after)) >
            Date.parse(String(operation.before))
        )
      );
    case 'remember':
      return (
        hasOnlyKeys(operation, [
          'mode',
          'content',
          'kind',
          'subjectId',
          'sourceMessageId',
          'toolCallId',
        ]) &&
        isText(operation.content, MAX_MEMORY_CONTENT_CHARS) &&
        isIdentifier(operation.toolCallId) &&
        optional(operation, 'kind', (item) =>
          ['fact', 'preference', 'event', 'plan', 'decision'].includes(
            String(item),
          ),
        ) &&
        optional(operation, 'subjectId', isIdentifier) &&
        optional(operation, 'sourceMessageId', isIdentifier)
      );
    case 'update':
      return (
        hasOnlyKeys(operation, [
          'mode',
          'id',
          'revision',
          'content',
          'toolCallId',
        ]) &&
        isIdentifier(operation.id) &&
        isInteger(operation.revision) &&
        isText(operation.content, MAX_MEMORY_CONTENT_CHARS) &&
        isIdentifier(operation.toolCallId)
      );
    case 'forget':
      return (
        hasOnlyKeys(operation, ['mode', 'id', 'revision', 'toolCallId']) &&
        isIdentifier(operation.id) &&
        optional(operation, 'revision', (item) => isInteger(item)) &&
        isIdentifier(operation.toolCallId)
      );
    default:
      return false;
  }
}
