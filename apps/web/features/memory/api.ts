import type {
  MemoryEvidenceDto,
  MemoryItemDto,
  MemoryItemStatus,
  MemoryJobDto,
  MemoryKind,
  MemoryListDto,
  MemorySettingsDto,
  MemoryStatusDto,
  MemoryScopeDto,
  MemorySubjectDto,
  MemorySessionSettingsDto,
} from '@fateclaw/contracts/memory';

import { requestJson } from '@/lib/http/client';

export interface MemoryFilters {
  q?: string;
  subject_id?: string;
  scope_id?: string;
  status?: MemoryItemStatus | 'all';
  kind?: MemoryKind | '';
  cursor?: string;
  limit?: number;
}

export interface MemoryScopesData {
  scopes: MemoryScopeDto[];
  subjects: MemorySubjectDto[];
}

export interface MemoryScopeBindingUpdate {
  speaker_subject_id: string | null;
  share_subject_memory: boolean;
  display_name?: string;
  revision: number;
}

export interface MemorySessionList {
  sessions: MemorySessionSettingsDto[];
  next_cursor: string | null;
}

const options = (signal?: AbortSignal) => ({ signal, timeoutMs: 15_000 });
const itemPath = (id: string) => `/api/memory/${encodeURIComponent(id)}`;

export const memoryApi = {
  sessions: (
    filters: { cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams();
    if (filters.cursor) query.set('cursor', filters.cursor);
    if (filters.limit) query.set('limit', String(filters.limit));
    const search = query.toString();
    return requestJson<MemorySessionList>(
      `/api/memory/sessions${search ? `?${search}` : ''}`,
      options(signal),
    );
  },
  updateSessionSettings: (
    id: string,
    data: { learning_enabled: boolean; revision: number },
    signal?: AbortSignal,
  ) =>
    requestJson<MemorySessionSettingsDto>(
      `/api/memory/sessions/${encodeURIComponent(id)}`,
      { ...options(signal), method: 'PATCH', body: JSON.stringify(data) },
    ),
  scopes: (signal?: AbortSignal) =>
    requestJson<MemoryScopesData>('/api/memory/scopes', options(signal)),
  updateScopeBinding: (
    id: string,
    data: MemoryScopeBindingUpdate,
    signal?: AbortSignal,
  ) =>
    requestJson<MemoryScopeDto>(
      `/api/memory/scopes/${encodeURIComponent(id)}/binding`,
      { ...options(signal), method: 'PATCH', body: JSON.stringify(data) },
    ),
  list: (filters: MemoryFilters = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== '') params.set(key, String(value));
    }
    const query = params.toString();
    return requestJson<MemoryListDto>(
      `/api/memory${query ? `?${query}` : ''}`,
      options(signal),
    );
  },
  settings: (signal?: AbortSignal) =>
    requestJson<MemorySettingsDto>('/api/memory/settings', options(signal)),
  updateSettings: (
    data: Partial<
      Pick<
        MemorySettingsDto,
        'learning_enabled' | 'recall_enabled' | 'chat_editing_enabled'
      >
    > & { revision: number },
    signal?: AbortSignal,
  ) =>
    requestJson<MemorySettingsDto>('/api/memory/settings', {
      ...options(signal),
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  create: (
    data: { content: string; kind?: MemoryKind; subject_id?: string },
    signal?: AbortSignal,
  ) =>
    requestJson<MemoryItemDto>('/api/memory', {
      ...options(signal),
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (
    id: string,
    content: string,
    revision: number,
    signal?: AbortSignal,
  ) =>
    requestJson<MemoryItemDto>(itemPath(id), {
      ...options(signal),
      method: 'PATCH',
      body: JSON.stringify({ content, revision }),
    }),
  forget: (id: string, revision: number, signal?: AbortSignal) =>
    requestJson<{ success: true }>(`${itemPath(id)}?revision=${revision}`, {
      ...options(signal),
      method: 'DELETE',
    }),
  evidence: (id: string, signal?: AbortSignal) =>
    requestJson<{ evidence: MemoryEvidenceDto[] }>(
      `${itemPath(id)}/evidence`,
      options(signal),
    ),
  excludeSource: (id: string, signal?: AbortSignal) =>
    requestJson<{ success: true }>(
      `/api/memory/sources/${encodeURIComponent(id)}/exclude`,
      {
        ...options(signal),
        method: 'POST',
      },
    ),
  clear: (resetContext: boolean, signal?: AbortSignal) =>
    requestJson<MemorySettingsDto>('/api/memory/clear', {
      ...options(signal),
      method: 'POST',
      body: JSON.stringify({ reset_context: resetContext }),
    }),
  status: (signal?: AbortSignal) =>
    requestJson<MemoryStatusDto>('/api/memory/status', options(signal)),
  backfill: (
    data: {
      session_ids?: string[];
      scope_ids?: string[];
      client_id?: string;
      from?: string;
      to?: string;
    },
    signal?: AbortSignal,
  ) =>
    requestJson<MemoryJobDto>('/api/memory/backfill', {
      ...options(signal),
      method: 'POST',
      body: JSON.stringify(data),
    }),
  pauseJob: (id: string, signal?: AbortSignal) =>
    requestJson<MemoryJobDto>(
      `/api/memory/jobs/${encodeURIComponent(id)}/pause`,
      {
        ...options(signal),
        method: 'POST',
      },
    ),
  resumeJob: (id: string, signal?: AbortSignal) =>
    requestJson<MemoryJobDto>(
      `/api/memory/jobs/${encodeURIComponent(id)}/resume`,
      {
        ...options(signal),
        method: 'POST',
      },
    ),
};
