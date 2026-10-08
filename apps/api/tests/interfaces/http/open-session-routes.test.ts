import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OpenSessionRow } from '../../../src/infrastructure/repositories/open-sessions-repository.js';
import type { EffectiveLlmRuntimeConfig } from '../../../src/modules/system/system-config.js';

const mocks = vi.hoisted(() => ({
  archiveChatSession: vi.fn(),
  createChatSession: vi.fn(),
  createOpenSession: vi.fn(),
  findOpenSessionByIdForUser: vi.fn(),
  softDeleteOpenSession: vi.fn(),
  storeMessage: vi.fn(),
  toOpenSessionDto: vi.fn(),
  touchOpenSessionActivity: vi.fn(),
  dispatchAiChatPrompt: vi.fn(),
  claimOrRefreshSessionProcessingLock: vi.fn(),
  releaseSessionProcessingLock: vi.fn(),
  resolveOfficialLlmRuntime: vi.fn(),
  resolveOfficialRuntimeByModelKey: vi.fn(),
  getRuntimeEntitlementSnapshot: vi.fn(),
  requireApiKeyPrincipal: vi.fn(),
}));

vi.mock('../../../src/infrastructure/db.js', () => ({
  archiveChatSession: mocks.archiveChatSession,
  createChatSession: mocks.createChatSession,
  createOpenSession: mocks.createOpenSession,
  findOpenSessionByIdForUser: mocks.findOpenSessionByIdForUser,
  softDeleteOpenSession: mocks.softDeleteOpenSession,
  storeMessage: mocks.storeMessage,
  toOpenSessionDto: mocks.toOpenSessionDto,
  touchOpenSessionActivity: mocks.touchOpenSessionActivity,
}));

vi.mock('../../../src/runtime/resident-agent.js', () => ({
  dispatchAiChatPrompt: mocks.dispatchAiChatPrompt,
}));

vi.mock('../../../src/runtime/ipc-payloads.js', () => ({
  claimOrRefreshSessionProcessingLock:
    mocks.claimOrRefreshSessionProcessingLock,
  releaseSessionProcessingLock: mocks.releaseSessionProcessingLock,
}));

vi.mock('../../../src/modules/system/system-config.js', () => ({
  resolveOfficialLlmRuntime: mocks.resolveOfficialLlmRuntime,
  resolveOfficialRuntimeByModelKey: mocks.resolveOfficialRuntimeByModelKey,
}));

vi.mock('../../../src/modules/billing/entitlements.js', () => ({
  getRuntimeEntitlementSnapshot: mocks.getRuntimeEntitlementSnapshot,
}));

vi.mock('../../../src/interfaces/http/api-key-auth.js', () => ({
  requireApiKeyPrincipal: mocks.requireApiKeyPrincipal,
  sendOpenAiError: (
    reply: FastifyReply,
    statusCode: number,
    message: string,
    type: string,
    code: string,
  ) =>
    reply
      .code(statusCode)
      .send({ error: { message, type, code, param: null } }),
}));

import { openSessionRoutes } from '../../../src/interfaces/http/open-session-routes.js';

function runtimeFixture(
  patch: Partial<EffectiveLlmRuntimeConfig> = {},
): EffectiveLlmRuntimeConfig {
  return {
    source: 'official',
    billingMode: 'metered',
    modelConfigId: 'official-slot',
    providerKey: 'current-official',
    piApi: 'openai-responses',
    displayName: 'Official model',
    authMode: 'openai_api_key',
    secret: 'synthetic-test-secret',
    secretSource: 'database',
    baseUrl: null,
    model: 'current-provider-model',
    contextWindowTokens: 128_000,
    maxOutputTokens: 4_000,
    thinkingLevel: 'high',
    inputTokenPricePerMillionCoins: 1,
    outputTokenPricePerMillionCoins: 2,
    ...patch,
  };
}

function sessionFixture(patch: Partial<OpenSessionRow> = {}): OpenSessionRow {
  return {
    id: 'sess_synthetic',
    user_id: 'user-1',
    api_key_id: 'key-1',
    runtime_session_id: 'openapi:synthetic-session',
    model_key: 'legacy-official',
    thinking_level: 'off',
    persona_prompt: 'Give concise answers.',
    authorized_skill_ids: null,
    board: null,
    status: 'active',
    created_at: new Date('2026-10-01T00:00:00.000Z'),
    last_active_at: new Date('2026-10-01T00:00:00.000Z'),
    expires_at: new Date('2026-11-01T00:00:00.000Z'),
    ...patch,
  };
}

describe('openSessionRoutes platform model configuration', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.resetAllMocks();
    mocks.requireApiKeyPrincipal.mockReturnValue({
      userId: 'user-1',
      apiKeyId: 'key-1',
      keyName: 'Synthetic test key',
    });
    mocks.resolveOfficialRuntimeByModelKey.mockResolvedValue(runtimeFixture());
    mocks.resolveOfficialLlmRuntime.mockResolvedValue(runtimeFixture());
    mocks.createChatSession.mockResolvedValue(undefined);
    mocks.createOpenSession.mockResolvedValue(
      sessionFixture({ model_key: 'current-official', thinking_level: 'high' }),
    );
    mocks.toOpenSessionDto.mockImplementation((row: OpenSessionRow) => ({
      id: row.id,
      object: 'session',
      model: row.model_key,
      status: row.status,
    }));
    mocks.findOpenSessionByIdForUser.mockResolvedValue(sessionFixture());
    mocks.getRuntimeEntitlementSnapshot.mockResolvedValue({
      userId: 'user-1',
      membershipActive: true,
      planKey: 'fateclaw_clarity',
      planRank: 1,
      hasPaidMembership: true,
      hasPriorityQueue: true,
      canUseWechatClaw: false,
      wallet: {
        purchasedCoins: 100,
        bonusCoins: 0,
        reservedCoins: 0,
        availableCoins: 100,
        inArrears: false,
      },
    });
    mocks.claimOrRefreshSessionProcessingLock.mockResolvedValue(true);
    mocks.releaseSessionProcessingLock.mockResolvedValue(undefined);
    mocks.storeMessage.mockResolvedValue(undefined);
    mocks.touchOpenSessionActivity.mockResolvedValue(undefined);
    mocks.dispatchAiChatPrompt.mockResolvedValue({
      status: 'success',
      requestId: 'synthetic-request',
      text: 'Synthetic reply',
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    });

    app = Fastify({ logger: false });
    await app.register(openSessionRoutes, { prefix: '/api/v1/sessions' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('creates a session without a client model using backend model and thinking configuration', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { system: 'Give concise answers.' },
    });

    expect(response.statusCode).toBe(201);
    expect(mocks.resolveOfficialRuntimeByModelKey).toHaveBeenCalledWith(
      undefined,
    );
    expect(mocks.createOpenSession).toHaveBeenCalledWith({
      userId: 'user-1',
      apiKeyId: 'key-1',
      runtimeSessionId: expect.stringMatching(/^openapi:/),
      modelKey: 'current-official',
      thinkingLevel: 'high',
      persona: 'Give concise answers.',
      skillIds: null,
      board: null,
    });
    const created = mocks.createOpenSession.mock.calls[0]![0];
    expect(mocks.createChatSession).toHaveBeenCalledWith({
      id: created.runtimeSessionId,
      accountId: 'web:user-1',
      userId: 'user-1',
      title: 'API 会话',
    });
    expect(response.json()).toEqual({
      id: 'sess_synthetic',
      object: 'session',
      model: 'current-official',
      status: 'active',
    });
  });

  it('rejects client thinking levels before resolving or creating a session', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { fateclaw: { thinking_level: 'xhigh' } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        type: 'invalid_request_error',
        code: 'invalid_request',
        param: null,
      },
    });
    expect(mocks.resolveOfficialRuntimeByModelKey).not.toHaveBeenCalled();
    expect(mocks.createChatSession).not.toHaveBeenCalled();
    expect(mocks.createOpenSession).not.toHaveBeenCalled();
  });

  it('passes an optional model alias to the sole-model resolver', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { model: ' current-official ' },
    });

    expect(response.statusCode).toBe(201);
    expect(mocks.resolveOfficialRuntimeByModelKey).toHaveBeenCalledWith(
      'current-official',
    );
    expect(mocks.createOpenSession).toHaveBeenCalledWith(
      expect.objectContaining({
        modelKey: 'current-official',
        thinkingLevel: 'high',
      }),
    );
  });

  it('rejects an unavailable or unrecognized official model without creating session rows', async () => {
    mocks.resolveOfficialRuntimeByModelKey.mockResolvedValueOnce(null);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { model: 'legacy-official' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'model_not_found' },
    });
    expect(mocks.createChatSession).not.toHaveBeenCalled();
    expect(mocks.createOpenSession).not.toHaveBeenCalled();
  });

  it('uses and reports the current backend configuration on every turn of a legacy session', async () => {
    const firstRuntime = runtimeFixture();
    const secondRuntime = runtimeFixture({
      providerKey: 'updated-official',
      model: 'updated-provider-model',
      thinkingLevel: 'low',
    });
    mocks.resolveOfficialLlmRuntime
      .mockResolvedValueOnce(firstRuntime)
      .mockResolvedValueOnce(secondRuntime);

    for (const [index, runtime] of [firstRuntime, secondRuntime].entries()) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/sess_synthetic/messages',
        payload: { content: `Turn ${index + 1}` },
      });

      expect(response.statusCode).toBe(200);
      expect(mocks.dispatchAiChatPrompt).toHaveBeenNthCalledWith(
        index + 1,
        expect.objectContaining({
          sessionId: 'openapi:synthetic-session',
          accountId: 'web:user-1',
          userMessage: `Turn ${index + 1}`,
          history: [],
          authorizedSkillIds: [],
          llmRuntime: runtime,
          waitForResponse: true,
        }),
      );
      expect(response.json()).toMatchObject({
        object: 'chat.completion',
        model: runtime.providerKey,
        choices: [
          { message: { role: 'assistant', content: 'Synthetic reply' } },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      });
    }

    expect(mocks.resolveOfficialLlmRuntime).toHaveBeenCalledTimes(2);
    expect(mocks.resolveOfficialRuntimeByModelKey).not.toHaveBeenCalled();
    expect(mocks.findOpenSessionByIdForUser).toHaveBeenNthCalledWith(
      1,
      'sess_synthetic',
      'user-1',
    );
    expect(mocks.findOpenSessionByIdForUser).toHaveBeenNthCalledWith(
      2,
      'sess_synthetic',
      'user-1',
    );
  });

  it('blocks legacy-session messages when the current platform model is unavailable', async () => {
    mocks.resolveOfficialLlmRuntime.mockResolvedValueOnce(null);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions/sess_synthetic/messages',
      payload: { content: 'Continue the legacy session.' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'model_not_found' },
    });
    expect(mocks.resolveOfficialRuntimeByModelKey).not.toHaveBeenCalled();
    expect(mocks.claimOrRefreshSessionProcessingLock).not.toHaveBeenCalled();
    expect(mocks.dispatchAiChatPrompt).not.toHaveBeenCalled();
  });
});
