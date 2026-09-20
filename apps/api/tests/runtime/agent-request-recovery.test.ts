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
vi.mock(
  '../../src/infrastructure/repositories/agent-requests-repository.js',
  () => ({
    renewAgentRequestLeases: f.renew,
    takeRecoverableRequests: f.take,
    persistAgentFailure: f.failure,
    interruptAgentRequest: f.interrupt,
    acknowledgeAgentInterruption: f.ack,
  }),
);
vi.mock('../../src/runtime/local-runner.js', () => ({
  ensureLocalAgentRunning: vi.fn(async () => {}),
}));
vi.mock('../../src/modules/system/system-config.js', () => ({
  resolveUserLlmRuntime: f.runtime,
}));
vi.mock('../../src/runtime/ipc-worker.js', () => ({
  getPendingAiChatRequests: () => new Map(),
  submitAiChatInboxRequest: f.submit,
  releaseGlobalAgentSlot: f.release,
}));
vi.mock('../../src/runtime/ipc-ai-chat-outbox-handler.js', () => ({
  processAiChatOutboxPayload: f.deliver,
}));
vi.mock('../../src/infrastructure/logger.js', () => ({
  logger: { error: vi.fn() },
}));
import {
  recoverAgentRequest,
  runAgentRequestRecoveryOnce,
} from '../../src/runtime/agent-request-recovery.js';
import type { DurableRequest } from '../../src/infrastructure/repositories/agent-requests-repository.js';

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
  it('refuses to silently switch provider configuration during recovery', async () => {
    f.runtime.mockResolvedValue({ ...request().runtime, model: 'other' });
    await recoverAgentRequest(request());
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
