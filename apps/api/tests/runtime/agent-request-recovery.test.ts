import { beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  runtime: vi.fn(),
  submit: vi.fn(),
  deliver: vi.fn(),
  interrupt: vi.fn(),
  ack: vi.fn(),
  failure: vi.fn(),
  take: vi.fn(),
  renew: vi.fn(),
  release: vi.fn(),
}));
vi.mock('#infrastructure/repositories/agent-requests-repository', () => ({
  renewAgentRequestLeases: f.renew,
  takeRecoverableRequests: f.take,
  persistAgentFailure: f.failure,
  interruptAgentRequest: f.interrupt,
  acknowledgeAgentInterruption: f.ack,
}));
vi.mock('#runtime/local-runner', () => ({
  ensureLocalAgentRunning: vi.fn(async () => {}),
}));
vi.mock('#modules/system/system-config', () => ({
  resolveUserLlmRuntime: f.runtime,
}));
vi.mock('#runtime/ipc-worker', () => ({
  getPendingAiChatRequests: () => new Map(),
  submitAiChatInboxRequest: f.submit,
  releaseGlobalAgentSlot: f.release,
}));
vi.mock('#runtime/ipc-ai-chat-outbox-handler', () => ({
  processAiChatOutboxPayload: f.deliver,
}));
vi.mock('#infrastructure/logger', () => ({
  logger: { error: vi.fn(), debug: vi.fn() },
}));
import {
  recoverAgentRequest,
  runAgentRequestRecoveryOnce,
} from '#runtime/agent-request-recovery';
import type { DurableRequest } from '#infrastructure/repositories/agent-requests-repository';

function request(overrides: Partial<DurableRequest> = {}): DurableRequest {
  return {
    request_id: 'request',
    execution_id: 'execution',
    account_id: 'web:user',
    owner_user_id: 'user',
    session_id: 'session',
    user_message_id: 'message',
    input: {
      accountId: 'web:user',
      sessionId: 'session',
      userMessage: 'question',
      history: [],
    },
    runtime: {
      source: 'official',
      billingMode: 'metered',
      modelConfigId: 'model-config',
      model: 'model',
      providerKey: 'provider',
      piApi: 'openai-completions',
      authMode: 'openai_api_key',
      inputTokenPricePerMillionCoins: 12,
      outputTokenPricePerMillionCoins: 24,
    },
    state: 'dispatched',
    deadline_at: new Date(Date.now() + 60_000),
    cancel_requested_at: null,
    result: null,
    ...overrides,
  };
}

describe('durable request recovery', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    f.runtime.mockResolvedValue({
      ...request().runtime,
      secret: 'synthetic-test-credential',
      baseUrl: null,
      inputTokenPricePerMillionCoins: 99,
      maxOutputTokens: 1000,
      contextWindowTokens: 10000,
    });
    f.interrupt.mockResolvedValue(true);
    f.failure.mockImplementation(async (_id, result) => result);
    f.take.mockResolvedValue([]);
  });
  it('resubmits only unstarted work with the same execution, deadline and admitted prices', async () => {
    const row = request();
    await recoverAgentRequest(row);
    expect(f.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: row.request_id,
        recoveryExecutionId: row.execution_id,
        recoveryDeadlineAt: new Date(row.deadline_at).toISOString(),
        llmRuntime: expect.objectContaining({
          secret: 'synthetic-test-credential',
          inputTokenPricePerMillionCoins: 12,
        }),
      }),
    );
  });
  it('uses the current backend thinking level for unstarted historical requests', async () => {
    const row = request();
    row.runtime.thinkingLevel = 'xhigh';
    f.runtime.mockResolvedValue({
      ...row.runtime,
      secret: 'synthetic-test-credential',
      baseUrl: null,
      thinkingLevel: 'low',
    });
    await recoverAgentRequest(row);
    expect(f.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        llmRuntime: expect.objectContaining({
          thinkingLevel: 'low',
          inputTokenPricePerMillionCoins: 12,
        }),
      }),
    );
  });
  it('refuses to silently switch provider configuration during recovery', async () => {
    f.runtime.mockResolvedValue({ ...request().runtime, model: 'other' });
    await recoverAgentRequest(request());
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.failure).toHaveBeenCalledOnce();
  });
  it('rehydrates pool credentials only for unchanged admitted node revisions', async () => {
    const row = request();
    const stored = {
      modelConfigId: 'node-a',
      revision: 2,
      weight: 1,
      piApi: 'openai-completions' as const,
      model: 'model-a',
      providerKey: 'provider-a',
      authMode: 'openai_api_key' as const,
    };
    row.runtime.poolNodes = [stored];
    f.runtime.mockResolvedValue({
      ...row.runtime,
      secret: 'synthetic-key',
      baseUrl: null,
      poolNodes: [{ ...stored, apiKey: 'synthetic-node-key' }],
    });
    await recoverAgentRequest(row);
    expect(f.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        llmRuntime: expect.objectContaining({
          poolNodes: [
            expect.objectContaining({
              apiKey: 'synthetic-node-key',
              revision: 2,
            }),
          ],
        }),
      }),
    );
    f.submit.mockClear();
    f.runtime.mockResolvedValue({
      ...row.runtime,
      secret: 'synthetic-key',
      baseUrl: null,
      poolNodes: [{ ...stored, revision: 3, apiKey: 'synthetic-revised-key' }],
    });
    await recoverAgentRequest(row);
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.failure).toHaveBeenCalledOnce();
  });
  it('never reexecutes an expired running request or finalizes unknown usage', async () => {
    await recoverAgentRequest(request({ state: 'running' }));
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.runtime).not.toHaveBeenCalled();
    expect(f.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ synthetic_terminal: true }),
      }),
      'web:user',
      expect.any(Map),
    );
    expect(f.ack).toHaveBeenCalledWith('request');
  });
  it('retains an interruption for retry if its message cannot be committed', async () => {
    f.deliver.mockRejectedValue(new Error('database unavailable'));
    await expect(
      recoverAgentRequest(request({ state: 'running' })),
    ).rejects.toThrow();
    expect(f.ack).not.toHaveBeenCalled();
  });
  it('delivers a stored result without resolving credentials or starting a worker', async () => {
    const result = { type: 'response', text: 'already generated' };
    await recoverAgentRequest(request({ state: 'result_ready', result }));
    expect(f.deliver).toHaveBeenCalledWith(result, 'web:user', expect.any(Map));
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.runtime).not.toHaveBeenCalled();
  });
  it('does not deliver stale failure if execution raced the cancellation', async () => {
    f.failure.mockResolvedValue(null);
    await recoverAgentRequest(request({ cancel_requested_at: new Date() }));
    expect(f.deliver).not.toHaveBeenCalled();
  });
  it('claims one request at a time and continues after a recoverable failure', async () => {
    f.take
      .mockResolvedValueOnce([request({ state: 'result_ready' })])
      .mockResolvedValueOnce([
        request({ request_id: 'second', state: 'result_ready' }),
      ]);
    f.deliver.mockRejectedValueOnce(new Error('transient'));
    await runAgentRequestRecoveryOnce();
    expect(f.deliver).toHaveBeenCalledTimes(2);
    expect(f.take).toHaveBeenCalledTimes(3);
  });
});
