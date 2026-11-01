import { afterEach, describe, expect, it, vi } from 'vitest';

import { memoryApi } from '@/features/memory/api';

afterEach(() => vi.unstubAllGlobals());

function stubFetch() {
  const fetchMock = vi.fn<typeof fetch>(
    async () =>
      new Response('{}', {
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('memory API contracts', () => {
  it('requests all item states explicitly instead of falling back to active', async () => {
    const fetchMock = stubFetch();
    await memoryApi.list({ status: 'all' });
    const url = new URL(
      String(fetchMock.mock.calls[0][0]),
      'https://example.invalid',
    );
    expect(url.searchParams.get('status')).toBe('all');
  });

  it('keeps speaker scope filters and backfill scope IDs explicit', async () => {
    const fetchMock = stubFetch();
    await memoryApi.list({ status: 'all', scope_id: 'speaker-scope-1' });
    await memoryApi.backfill({
      scope_ids: ['speaker-scope-1'],
      session_ids: ['session-1'],
    });
    const url = new URL(
      String(fetchMock.mock.calls[0][0]),
      'https://example.invalid',
    );
    expect(url.searchParams.get('scope_id')).toBe('speaker-scope-1');
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      scope_ids: ['speaker-scope-1'],
      session_ids: ['session-1'],
    });
  });

  it('saves an explicit speaker identity and sharing choice with the binding revision', async () => {
    const fetchMock = stubFetch();
    await memoryApi.updateScopeBinding('scope/test', {
      speaker_subject_id: 'client-1',
      share_subject_memory: false,
      display_name: '同名联系人',
      revision: 7,
    });
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      '/api/memory/scopes/scope%2Ftest/binding',
    );
    expect(fetchMock.mock.calls[0][1]?.method).toBe('PATCH');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      speaker_subject_id: 'client-1',
      share_subject_memory: false,
      display_name: '同名联系人',
      revision: 7,
    });
  });

  it('updates only the selected conversation learning preference with its own revision', async () => {
    const fetchMock = stubFetch();
    await memoryApi.updateSessionSettings('session/one', {
      learning_enabled: false,
      revision: 9,
    });
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      '/api/memory/sessions/session%2Fone',
    );
    expect(fetchMock.mock.calls[0][1]?.method).toBe('PATCH');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      learning_enabled: false,
      revision: 9,
    });
  });
});
