import {
  isMemoryReference,
  type MemoryOperation,
  type MemoryResult,
} from '@fateclaw/contracts/agent/memory';
import type {
  MemoryExcerpt,
  MemoryHydration,
  MemoryReference,
  MemoryRequestScope,
} from '@fateclaw/contracts/memory';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseMemoryReference(
  value: unknown,
): MemoryReference | undefined {
  if (!isMemoryReference(value)) return undefined;
  return {
    kind: value.kind,
    id: value.id,
    revision: value.revision,
    ...(value.score !== undefined ? { score: value.score } : {}),
    ...(value.offset !== undefined ? { offset: value.offset } : {}),
    ...(value.limit !== undefined ? { limit: value.limit } : {}),
  };
}

export function parseMemoryReferences(value: unknown): MemoryReference[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const reference = parseMemoryReference(entry);
    return reference ? [reference] : [];
  });
}

export function memoryReferenceKey(reference: MemoryReference): string {
  return JSON.stringify([
    reference.kind,
    reference.id,
    reference.revision,
    reference.offset ?? null,
    reference.limit ?? null,
  ]);
}

/** Hydrated text held only in process memory for the current request, keyed by reference. */
export type RequestMemoryExcerpts = Map<string, MemoryExcerpt>;

export function memoryUnavailable(
  code = 'MEMORY.UNAVAILABLE',
): MemoryResult & { ok: false } {
  return {
    ok: false,
    code,
    error: '记忆服务暂时不可用；不要声称已读取或保存记忆',
  };
}

const HYDRATION_STATUSES = ['ready', 'partial', 'disabled', 'unavailable'];

function parseExcerpt(value: unknown): MemoryExcerpt[] {
  const item = record(value);
  const reference = parseMemoryReference(item?.reference);
  if (
    !item ||
    !reference ||
    typeof item.text !== 'string' ||
    typeof item.label !== 'string'
  )
    return [];
  const next = parseMemoryReference(item.nextReference);
  return [
    {
      reference,
      text: item.text,
      label: item.label,
      ...(typeof item.observedAt === 'string'
        ? { observedAt: item.observedAt }
        : {}),
      ...(typeof item.sourceMessageId === 'string'
        ? { sourceMessageId: item.sourceMessageId }
        : {}),
      ...(typeof item.sourceSessionId === 'string'
        ? { sourceSessionId: item.sourceSessionId }
        : {}),
      ...(Array.isArray(item.sourceReferences)
        ? { sourceReferences: parseMemoryReferences(item.sourceReferences) }
        : {}),
      ...(next ? { nextReference: next } : {}),
      ...(item.automatic === true ? { automatic: true } : {}),
    },
  ];
}

function parseHydration(value: unknown): MemoryHydration | undefined {
  const hydration = record(value);
  if (
    !hydration ||
    !HYDRATION_STATUSES.includes(String(hydration.status)) ||
    !Number.isSafeInteger(hydration.epoch) ||
    !Number.isSafeInteger(hydration.contextGeneration) ||
    !Number.isSafeInteger(hydration.tokenBudget) ||
    Number(hydration.tokenBudget) < 0 ||
    !Array.isArray(hydration.excerpts) ||
    (hydration.contextAudience !== undefined &&
      (typeof hydration.contextAudience !== 'string' ||
        hydration.contextAudience.length > 256))
  )
    return undefined;
  return {
    status: hydration.status as MemoryHydration['status'],
    epoch: Number(hydration.epoch),
    contextGeneration: Number(hydration.contextGeneration),
    ...(typeof hydration.contextAudience === 'string'
      ? { contextAudience: hydration.contextAudience }
      : {}),
    tokenBudget: Number(hydration.tokenBudget),
    excerpts: hydration.excerpts.flatMap(parseExcerpt),
  };
}

/** Signed replies still cross a data boundary; only hydration may carry read text. */
export function parseMemoryResult(
  value: unknown,
  mode: MemoryOperation['mode'],
): MemoryResult {
  const result = record(value);
  if (!result || typeof result.ok !== 'boolean') return memoryUnavailable();
  if (!result.ok)
    return memoryUnavailable(
      typeof result.code === 'string' &&
        /^MEMORY\.[A-Z_]{1,64}$/.test(result.code)
        ? result.code
        : undefined,
    );
  if (result.mode !== mode) return memoryUnavailable();
  if (mode === 'prepare' || mode === 'read' || mode === 'search') {
    const hydration = parseHydration(result.hydration);
    return hydration ? { ok: true, mode, hydration } : memoryUnavailable();
  }
  if (mode === 'remember' || mode === 'update') {
    const reference = parseMemoryReference(result.reference);
    return reference ? { ok: true, mode, reference } : memoryUnavailable();
  }
  return typeof result.forgottenId === 'string'
    ? { ok: true, mode: 'forget', forgottenId: result.forgottenId }
    : memoryUnavailable();
}

/** A clear or reset between admission and this call makes the hydration belong to another context. */
export function hydrationMatchesScope(
  hydration: MemoryHydration,
  scope: MemoryRequestScope,
): boolean {
  return (
    hydration.epoch === scope.epoch &&
    hydration.contextGeneration === scope.contextGeneration &&
    (hydration.contextAudience ?? '') === (scope.contextAudience ?? '')
  );
}
