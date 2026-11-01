import { afterEach, describe, expect, it, vi } from 'vitest';

import { accountsApi } from '@/features/accounts/api';

afterEach(() => vi.unstubAllGlobals());

describe('Soul compare-and-set API', () => {
  it('retains read and acknowledged hashes while text writes leave the independent switch untouched', async () => {
    const initial = 'a'.repeat(64),
      first = 'b'.repeat(64),
      second = 'c'.repeat(64);
    const bodies = [
      { content: 'Synthetic original', edit_enabled: true, sha256: initial },
      { success: true, sha256: first },
      { success: true, sha256: second },
    ];
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify(bodies.shift()), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const read = await accountsApi.getUserSoul();
    expect(read.sha256).toBe(initial);
    const saved = await accountsApi.updateUserSoul(
      'Synthetic first edit',
      read.sha256!,
    );
    expect(saved.sha256).toBe(first);
    await accountsApi.updateUserSoul('Synthetic next edit', saved.sha256);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      content: 'Synthetic first edit',
      base_hash: initial,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({
      content: 'Synthetic next edit',
      base_hash: first,
    });
  });

  it('changes chat editing through the dedicated switch endpoint', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response('{"success":true}', {
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await accountsApi.updateUserSoulEditEnabled(false);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      '/api/account/me/soul/edit-enabled',
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      edit_enabled: false,
    });
  });
});
