import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, requestJson } from './client';

const originalFetch = globalThis.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('requestJson', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('keeps generic server errors by default', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(502, { error: '自配模型 Base URL 无效' }));

    await expect(requestJson('/api/test')).rejects.toMatchObject({
      status: 502,
      message: '服务暂时不可用，请稍后重试',
    } satisfies Partial<ApiError>);
  });

  it('exposes server error messages when explicitly requested', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(502, { error: '自配模型 Base URL 无效' }));

    await expect(
      requestJson('/api/chat', { exposeServerErrorMessage: true }),
    ).rejects.toMatchObject({
      status: 502,
      message: '自配模型 Base URL 无效',
    } satisfies Partial<ApiError>);
  });

  it('disables browser cache for API requests by default', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { ok: true }));
    globalThis.fetch = fetchMock;

    await expect(requestJson('/api/test')).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/test',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });
});
