import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MEMORY_RUNTIME_POLICY } from '@fateclaw/contracts/memory';

const { policy, service, jobs, models, database, logger } = vi.hoisted(
  () => ({
    policy: {
      getMemoryRuntimePolicy: vi.fn(),
      saveMemoryRuntimePolicy: vi.fn(),
    },
    service: { memoryStatus: vi.fn() },
    jobs: {
      startMemoryBackfill: vi.fn(),
      changeMemoryJobState: vi.fn(),
      retryMemoryJob: vi.fn(),
    },
    models: {
      getPlatformModelSettings: vi.fn(),
      getPlatformModelRuntimeSettings: vi.fn(),
    },
    database: { query: vi.fn() },
    logger: { error: vi.fn() },
  }),
);
vi.mock('#modules/memory/policy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#modules/memory/policy')>()),
  ...policy,
}));
vi.mock('#modules/memory/service', () => service);
vi.mock('#modules/memory/jobs', () => jobs);
vi.mock('#infrastructure/repositories/config-repository', () => models);
vi.mock('#infrastructure/db-pool', () => ({ getDbPool: () => database }));
vi.mock('#infrastructure/logger', () => ({ logger }));

import { adminMemoryRoutes } from '#interfaces/http/admin-memory-routes';
import { MemoryError } from '#modules/memory/domain';

const headers = { 'x-admin-key': 'synthetic-owner-admin' };
const nodes = [
  {
    model: {
      id: 'official-openai',
      enabled: true,
      pi_api: 'openai-completions',
      display_name: 'Synthetic OpenAI',
      model_name: 'synthetic-chat',
      api_key_secret_key: 'synthetic-metadata-reference',
    },
    hasSecret: true,
  },
  {
    model: {
      id: 'official-google',
      enabled: true,
      pi_api: 'google-generative-ai',
      display_name: 'Synthetic Google',
      model_name: 'synthetic-gemini',
    },
  },
  {
    model: {
      id: 'official-anthropic',
      enabled: true,
      pi_api: 'anthropic-messages',
      display_name: 'Synthetic Anthropic',
      model_name: 'synthetic-claude',
    },
  },
  {
    model: {
      id: 'official-disabled',
      enabled: false,
      pi_api: 'openai-completions',
      display_name: 'Disabled',
      model_name: 'disabled',
    },
  },
];

describe('admin memory HTTP routes', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    vi.resetAllMocks();
    policy.getMemoryRuntimePolicy.mockResolvedValue(
      DEFAULT_MEMORY_RUNTIME_POLICY,
    );
    policy.saveMemoryRuntimePolicy.mockImplementation(async (value) => ({
      ...value,
      revision: value.revision + 1,
    }));
    models.getPlatformModelSettings.mockResolvedValue({
      pool: { enabled: true },
      nodes,
    });
    service.memoryStatus.mockResolvedValue({
      pending_jobs: 2,
      failed_jobs: 1,
      active_items: 3,
      indexed_items: 2,
      recent_jobs: [],
    });
    database.query.mockResolvedValue({
      rows: [
        {
          purpose: 'memory.extract',
          calls: '2',
          input_tokens: '100',
          output_tokens: '20',
        },
      ],
    });
    app = Fastify({ logger: false });
    await app.register(
      async (admin) => {
        admin.addHook('onRequest', async (request, reply) => {
          if (request.headers['x-admin-key'] !== headers['x-admin-key'])
            return reply.code(403).send({ error: '无权访问该管理功能' });
          request.adminPrincipal = {
            role: 'owner',
            scopes: ['admin:*'],
            home_path: '/overview',
          };
        });
        await admin.register(adminMemoryRoutes);
      },
      { prefix: '/api/admin' },
    );
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  it.each([
    { method: 'GET', url: '/api/admin/memory' },
    {
      method: 'PUT',
      url: '/api/admin/memory/policy',
      payload: DEFAULT_MEMORY_RUNTIME_POLICY,
    },
    { method: 'POST', url: '/api/admin/memory/jobs/job/retry' },
  ] as const)(
    'inherits owner authorization for $method $url',
    async (request) => {
      expect((await app.inject(request)).statusCode).toBe(403);
      expect(service.memoryStatus).not.toHaveBeenCalled();
      expect(policy.saveMemoryRuntimePolicy).not.toHaveBeenCalled();
      expect(jobs.retryMemoryJob).not.toHaveBeenCalled();
    },
  );

  it('returns aggregate status and enabled model choices without loading or returning credentials', async () => {
    const response = await app.inject({ url: '/api/admin/memory', headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({
      pending_jobs: 2,
      policy: DEFAULT_MEMORY_RUNTIME_POLICY,
      usage_today: [
        {
          purpose: 'memory.extract',
          calls: 2,
          input_tokens: 100,
          output_tokens: 20,
        },
      ],
    });
    expect(response.json().model_choices).toEqual([
      {
        id: 'official-openai',
        display_name: 'Synthetic OpenAI',
        model_name: 'synthetic-chat',
      },
      {
        id: 'official-google',
        display_name: 'Synthetic Google',
        model_name: 'synthetic-gemini',
      },
      {
        id: 'official-anthropic',
        display_name: 'Synthetic Anthropic',
        model_name: 'synthetic-claude',
      },
    ]);
    expect(service.memoryStatus).toHaveBeenCalledWith();
    expect(models.getPlatformModelRuntimeSettings).not.toHaveBeenCalled();
    expect(response.body).not.toContain('api_key_secret_key');
    expect(response.body).not.toContain('synthetic-metadata-reference');
    expect(response.body).not.toContain('hasSecret');
  });

  it('validates explicit model nodes and returns the saved policy with its new revision', async () => {
    const input = {
      ...DEFAULT_MEMORY_RUNTIME_POLICY,
      extraction_model_id: 'official-openai',
    };
    const response = await app.inject({
      method: 'PUT',
      url: '/api/admin/memory/policy',
      headers,
      payload: input,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ...input, revision: input.revision + 1 });
    expect(policy.saveMemoryRuntimePolicy).toHaveBeenCalledWith(input, 'owner');
    expect(models.getPlatformModelRuntimeSettings).not.toHaveBeenCalled();
  });

  it.each([
    { unknown: true },
    { revision: 0 },
    { worker_concurrency: 33 },
    { extraction_model_id: 'official-disabled' },
    { extraction_model_id: 'missing-node' },
    // One extraction call reserves 8000 input + 2000 output tokens; it could never fit.
    { daily_token_budget: 9_999 },
  ])(
    'rejects invalid policy settings or unavailable models before save: %j',
    async (change) => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/memory/policy',
        headers,
        payload: { ...DEFAULT_MEMORY_RUNTIME_POLICY, ...change },
      });
      expect(response.statusCode).toBe(400);
      expect(policy.saveMemoryRuntimePolicy).not.toHaveBeenCalled();
    },
  );

  it('rejects model selection when the official pool is disabled', async () => {
    models.getPlatformModelSettings.mockResolvedValueOnce({
      pool: { enabled: false },
      nodes,
    });
    const response = await app.inject({
      method: 'PUT',
      url: '/api/admin/memory/policy',
      headers,
      payload: {
        ...DEFAULT_MEMORY_RUNTIME_POLICY,
        extraction_model_id: 'official-openai',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(policy.saveMemoryRuntimePolicy).not.toHaveBeenCalled();
  });

  it('retries a job through the owning service and preserves domain conflicts', async () => {
    jobs.retryMemoryJob.mockResolvedValueOnce({ id: 'job', state: 'pending' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/memory/jobs/job/retry',
      headers,
    });
    expect(response.json()).toEqual({ id: 'job', state: 'pending' });
    expect(jobs.retryMemoryJob).toHaveBeenCalledWith('job');
    jobs.retryMemoryJob.mockRejectedValueOnce(
      new MemoryError('任务状态已变化', 409, 'MEMORY.JOB_CONFLICT'),
    );
    const conflict = await app.inject({
      method: 'POST',
      url: '/api/admin/memory/jobs/job/retry',
      headers,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe('MEMORY.JOB_CONFLICT');
  });
});
