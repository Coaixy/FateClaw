import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCreateRequestRuntime,
  mockExecutePiRuntime,
  mockListTranscriptEvents,
  mockListScopedTraceEvents,
} = vi.hoisted(() => ({
  mockCreateRequestRuntime: vi.fn(),
  mockExecutePiRuntime: vi.fn(),
  mockListTranscriptEvents: vi.fn(),
  mockListScopedTraceEvents: vi.fn(),
}));

vi.mock('../src/runtime.js', () => ({
  createRequestRuntime: mockCreateRequestRuntime,
}));

vi.mock('../src/pi-runtime/index.js', () => ({
  executePiRuntime: mockExecutePiRuntime,
}));

vi.mock('../src/transcript-store.js', () => ({
  listTranscriptEvents: mockListTranscriptEvents,
}));

vi.mock('../src/request-scope.js', async () => {
  const actual = await vi.importActual<
    typeof import('../src/request-scope.js')
  >('../src/request-scope.js');
  return {
    ...actual,
    listScopedTraceEvents: mockListScopedTraceEvents,
  };
});

import { createRequestScope } from '../src/request-scope.js';
import { executeContainerInput } from '../src/request-boundary.js';
import { attachPartialUsage } from '../src/partial-usage.js';
import { ModelCallError } from '../src/public-error.js';
import type { LlmRuntimeSnapshot } from '../src/types.js';

const llmRuntime: LlmRuntimeSnapshot = {
  source: 'custom',
  billingMode: 'none',
  modelConfigId: 'user-1',
  piApi: 'openai-completions',
  model: 'gpt-4o',
  apiKey: 'test-key',
  authMode: 'openai_api_key',
  providerKey: 'main-openai',
};

describe('executeContainerInput user pasted board persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateRequestRuntime.mockReturnValue({ deps: {} });
    mockListTranscriptEvents.mockReturnValue([]);
    mockListScopedTraceEvents.mockReturnValue([]);
    mockExecutePiRuntime.mockResolvedValue({
      text: '解读结果',
      usage: {
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      },
      skillContext: [],
      agentGraph: {
        version: 1,
        requestId: 'request-1',
        accountId: 'web:user-1',
        sessionId: 'session-1',
        rootTaskId: 'task-root',
        tasks: [],
        evidence: [],
        edges: [],
        summary: {
          specialistSequence: [],
          taskCount: 0,
          evidenceCount: 0,
          finalTextPreview: '解读结果',
        },
      },
    });
  });

  it('keeps request boundary out of Pi context persistence decisions', async () => {
    const onSessionReady = vi.fn();
    const result = await executeContainerInput(
      {
        accountId: 'web:user-1',
        sessionId: 'session-1',
        llmRuntime,
        userMessage: '看看事业',
        inputKind: 'user_pasted_board',
        pastedBoard: {
          category: '六爻',
          content: '用户自贴盘面原文',
          question: '看看事业',
        },
        history: [],
      },
      createRequestScope(),
      undefined,
      { onSessionReady },
    );

    expect(result.status).toBe('success');
    expect(mockCreateRequestRuntime).toHaveBeenCalledTimes(1);
    expect(mockExecutePiRuntime).toHaveBeenCalledTimes(1);
    expect(mockExecutePiRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        containerInput: expect.objectContaining({
          inputKind: 'user_pasted_board',
          pastedBoard: expect.objectContaining({ category: '六爻' }),
        }),
        onSessionReady,
      }),
    );
    expect(result.skillContext).toBeUndefined();
  });

  it('在请求中途报错时回传截至出错的真实 partial usage', async () => {
    // 模拟:executePiRuntime 在跑了若干轮后抛错,error 上已挂载 partial usage。
    const partialUsage = {
      promptTokens: 1200,
      completionTokens: 340,
      totalTokens: 1540,
    };
    const boom = new Error('provider 第 3 轮返回错误');
    attachPartialUsage(boom, partialUsage);
    mockExecutePiRuntime.mockRejectedValueOnce(boom);

    const result = await executeContainerInput(
      {
        accountId: 'web:user-1',
        sessionId: 'session-1',
        llmRuntime,
        userMessage: '看看事业',
        inputKind: 'normal',
        history: [],
      },
      createRequestScope(),
    );

    expect(result.status).toBe('error');
    // 出错前已消耗的 token 必须随 error 响应回传,供宿主按真实用量结算。
    expect(result.usage).toEqual(partialUsage);
  });

  it('error 上未挂载 partial usage 时,usage 为 undefined', async () => {
    mockExecutePiRuntime.mockRejectedValueOnce(new Error('启动前就失败'));

    const result = await executeContainerInput(
      {
        accountId: 'web:user-1',
        sessionId: 'session-1',
        llmRuntime,
        userMessage: '看看事业',
        inputKind: 'normal',
        history: [],
      },
      createRequestScope(),
    );

    expect(result.status).toBe('error');
    expect(result.usage).toBeUndefined();
  });

  it('delivers the structured model cause and partial usage to the public response', async () => {
    const failure = new ModelCallError(
      { kinds: ['shared_pool_rate_limit'] },
      'benefit',
    );
    const usage = { promptTokens: 12, completionTokens: 0, totalTokens: 12 };
    attachPartialUsage(failure, usage);
    mockExecutePiRuntime.mockRejectedValueOnce(failure);
    const result = await executeContainerInput(
      {
        accountId: 'web:user-1',
        sessionId: 'session-1',
        llmRuntime: { ...llmRuntime, source: 'official', poolKey: 'benefit' },
        userMessage: 'Synthetic question',
        history: [],
      },
      createRequestScope(),
    );
    expect(result).toMatchObject({
      status: 'error',
      publicReasonCode: 'rate_limited',
      publicErrorText: expect.stringContaining('上游共享调用额度'),
      usage,
    });
    expect(result.publicErrorText).not.toContain('这次没有完成，原因：');
  });
});
