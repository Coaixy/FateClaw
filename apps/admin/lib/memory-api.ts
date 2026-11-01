import type {
  MemoryJobDto,
  MemoryRuntimePolicy,
  MemoryRuntimeStatusDto,
} from '@fateclaw/contracts/memory';

import { adminRequest } from '@/lib/admin-api';

async function request<T>(
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', abort);
  const timer = setTimeout(abort, 15_000);
  try {
    return await adminRequest<T>(path, {
      ...init,
      signal: controller.signal,
      cache: 'no-store',
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export const adminMemoryApi = {
  status: (signal?: AbortSignal) =>
    request<MemoryRuntimeStatusDto>('/api/admin/memory', {}, signal),
  savePolicy: (policy: MemoryRuntimePolicy, signal?: AbortSignal) =>
    request<MemoryRuntimePolicy>(
      '/api/admin/memory/policy',
      { method: 'PUT', body: JSON.stringify(policy) },
      signal,
    ),
  retryJob: (id: string, signal?: AbortSignal) =>
    request<MemoryJobDto>(
      `/api/admin/memory/jobs/${encodeURIComponent(id)}/retry`,
      { method: 'POST' },
      signal,
    ),
};
