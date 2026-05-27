import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockTryExecuteCommand,
  mockCreateRequestRuntime,
  mockExecutePiRuntime,
  mockListTranscriptEvents,
  mockListScopedTraceEvents,
} = vi.hoisted(() => ({
  mockTryExecuteCommand: vi.fn(),
  mockCreateRequestRuntime: vi.fn(),
  mockExecutePiRuntime: vi.fn(),
  mockListTranscriptEvents: vi.fn(),
  mockListScopedTraceEvents: vi.fn(),
}));

vi.mock('./commands.js', () => ({
  tryExecuteCommand: mockTryExecuteCommand,
}));

vi.mock('./runtime.js', () => ({
  createRequestRuntime: mockCreateRequestRuntime,
}));

vi.mock('./pi-runtime/index.js', () => ({
  executePiRuntime: mockExecutePiRuntime,
}));

vi.mock('./transcript-store.js', () => ({
  listTranscriptEvents: mockListTranscriptEvents,
}));

vi.mock('./request-scope.js', async () => {
  const actual = await vi.importActual<typeof import('./request-scope.js')>(
    './request-scope.js',
  );
  return {
    ...actual,
    listScopedTraceEvents: mockListScopedTraceEvents,
  };
});

import { createRequestScope } from './request-scope.js';
import { executeContainerInput } from './request-boundary.js';
import type { LlmRuntimeSnapshot } from './types.js';

const llmRuntime: LlmRuntimeSnapshot = {
  source: 'custom',
  billingMode: 'none',
  modelConfigId: 'user-1',
  provider: 'openai-compatible',
  model: 'gpt-4o',
  apiKey: 'test-key',
  authMode: 'openai_api_key',
  providerKey: 'main-openai',
};

describe('executeContainerInput user pasted board persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTryExecuteCommand.mockResolvedValue(null);
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
      }),
    );
    expect(result.skillContext).toBeUndefined();
  });
});
