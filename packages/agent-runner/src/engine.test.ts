import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockQueryLatestFollowupWorkflowContext,
  mockTryExecuteCommand,
  mockCreateRequestRuntime,
  mockExecutePiRuntime,
  mockListTranscriptEvents,
  mockListScopedTraceEvents,
} = vi.hoisted(() => ({
  mockQueryLatestFollowupWorkflowContext: vi.fn(),
  mockTryExecuteCommand: vi.fn(),
  mockCreateRequestRuntime: vi.fn(),
  mockExecutePiRuntime: vi.fn(),
  mockListTranscriptEvents: vi.fn(),
  mockListScopedTraceEvents: vi.fn(),
}));

vi.mock('./agent-db.js', () => ({
  queryLatestFollowupWorkflowContext: mockQueryLatestFollowupWorkflowContext,
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
import { executeContainerInput } from './engine.js';
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
    mockQueryLatestFollowupWorkflowContext.mockResolvedValue(null);
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
      skillContext: [
        {
          skill: 'xuanxue-jiedu',
          output: '解读结果',
        },
      ],
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

  it('stores pasted board context together with xuanxue interpretation output', async () => {
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
    expect(result.skillContext).toEqual([
      expect.objectContaining({
        skill: 'user-pasted-board::六爻',
        output: '用户自贴盘面原文',
        artifactType: 'skill.user-pasted-board::六爻',
        artifactTitle: '自贴盘面: 六爻',
        artifactData: {
          category: '六爻',
          content: '用户自贴盘面原文',
          question: '看看事业',
          source: 'user_pasted_board',
        },
      }),
      expect.objectContaining({
        skill: 'xuanxue-jiedu',
        output: '解读结果',
      }),
    ]);
  });
});
