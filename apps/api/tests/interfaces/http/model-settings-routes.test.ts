import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelSettingsOverviewDto } from '@fateclaw/contracts/model-settings';

const { mockGetUserModelSettingsOverview, mockRequireAuth } = vi.hoisted(
  () => ({
    mockGetUserModelSettingsOverview: vi.fn(),
    mockRequireAuth: vi.fn(),
  }),
);

vi.mock('#modules/system/system-config', () => ({
  getUserModelSettingsOverview: mockGetUserModelSettingsOverview,
}));

import { modelSettingsRoutes } from '#interfaces/http/model-settings-routes';

const overview: ModelSettingsOverviewDto = {
  model: {
    id: 'official-slot',
    model_key: 'official-model',
    display_name: 'Official model',
    description: 'Platform-managed model',
    model_name: 'synthetic-provider-model',
    context_window_tokens: 128_000,
    input_token_price_per_million_coins: 1,
    output_token_price_per_million_coins: 2,
    has_secret: true,
  },
};

const authenticatedHeaders = { authorization: 'Bearer synthetic-user' };

describe('modelSettingsRoutes readonly official model', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.resetAllMocks();
    mockGetUserModelSettingsOverview.mockResolvedValue(overview);
    mockRequireAuth.mockImplementation(async function (this: FastifyRequest) {
      if (this.headers.authorization !== authenticatedHeaders.authorization) {
        throw Object.assign(new Error('Authentication required'), {
          statusCode: 401,
        });
      }
      Object.assign(this, { user: { userId: 'synthetic-user' } });
    });

    app = Fastify({ logger: false });
    app.decorateRequest('requireAuth', mockRequireAuth);
    await app.register(modelSettingsRoutes, { prefix: '/api/model-settings' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('requires authentication before reading platform model settings', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/model-settings',
    });

    expect(response.statusCode).toBe(401);
    expect(mockRequireAuth).toHaveBeenCalledOnce();
    expect(mockGetUserModelSettingsOverview).not.toHaveBeenCalled();
  });

  it('returns only the official-model overview to authenticated users', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/model-settings',
      headers: authenticatedHeaders,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(overview);
    expect(Object.keys(response.json())).toEqual(['model']);
    expect(mockRequireAuth).toHaveBeenCalledOnce();
    expect(mockGetUserModelSettingsOverview).toHaveBeenCalledWith(
      'synthetic-user',
    );
  });

  it('reports an empty official slot without any user selection or fallback', async () => {
    mockGetUserModelSettingsOverview.mockResolvedValueOnce({ model: null });
    const response = await app.inject({
      method: 'GET',
      url: '/api/model-settings',
      headers: authenticatedHeaders,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ model: null });
  });

  it.each([
    { method: 'PUT', url: '/api/model-settings' },
    { method: 'GET', url: '/api/model-settings/official-models' },
    { method: 'PUT', url: '/api/model-settings/custom' },
    { method: 'PUT', url: '/api/model-settings/selection' },
  ] as const)('does not expose $method $url', async ({ method, url }) => {
    const response = await app.inject({
      method,
      url,
      headers: authenticatedHeaders,
    });

    expect(response.statusCode).toBe(404);
    expect(mockGetUserModelSettingsOverview).not.toHaveBeenCalled();
  });
});
