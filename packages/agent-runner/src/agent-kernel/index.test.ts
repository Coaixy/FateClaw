import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetContext,
  mockCreateCapabilityCatalog,
  mockRunKernelModelLoop,
  mockExecuteSpecialist,
} = vi.hoisted(() => ({
  mockGetContext: vi.fn(),
  mockCreateCapabilityCatalog: vi.fn(),
  mockRunKernelModelLoop: vi.fn(),
  mockExecuteSpecialist: vi.fn(),
}));

vi.mock('../context.js', () => ({
  getContext: mockGetContext,
}));

vi.mock('./capabilities.js', () => ({
  createCapabilityCatalog: mockCreateCapabilityCatalog,
}));

vi.mock('./model-loop.js', () => ({
  runKernelModelLoop: mockRunKernelModelLoop,
}));

vi.mock('./specialists.js', () => ({
  executeSpecialist: mockExecuteSpecialist,
}));

import { createRequestScope } from '../request-scope.js';
import type { LlmRuntimeSnapshot } from '../types.js';
import { executeAgentKernel } from './index.js';

const llmRuntime: LlmRuntimeSnapshot = {
  source: 'official',
  billingMode: 'metered',
  modelConfigId: 'official-1',
  provider: 'openai-compatible',
  model: 'gpt-4o',
  apiKey: 'db-secret',
  authMode: 'openai_api_key',
  providerKey: 'main-openai',
};

describe('executeAgentKernel active board routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockGetContext.mockReturnValue({
      accountId: 'web:user-1',
      userId: 'user-1',
      timezone: 'Asia/Shanghai',
      skillApiBase: 'http://localhost:8787',
    });

    mockCreateCapabilityCatalog.mockResolvedValue({
      descriptors: [],
      xuanxueInterpretationEnabled: true,
      boardSkillCatalog: [],
      createRegistryForSpecialist: vi.fn(() => ({
        toolDefinitions: [],
        buildToolPrompts: () => '',
        executeTool: vi.fn(),
        getExecutionMode: () => 'serial',
        getProtectedToolNames: () => new Set<string>(),
      })),
      listSpecialists: () => [
        {
          name: 'xuanxue-board-agent',
          responsibility: '排盘',
          capabilityIds: [],
        },
        {
          name: 'xuanxue-interpret-agent',
          responsibility: '解读',
          capabilityIds: [],
        },
      ],
    });

    mockExecuteSpecialist.mockResolvedValue({
      specialist: 'xuanxue-interpret-agent',
      success: true,
      text: '这是桃花解读',
      usage: {
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      },
      skillContext: [
        {
          skill: 'xuanxue-jiedu',
          output: '这是桃花解读',
        },
      ],
      newArtifacts: [],
    });
  });

  it('bypasses supervisor loop when activeBoardContext is present', async () => {
    const result = await executeAgentKernel({
      containerInput: {
        accountId: 'web:user-1',
        sessionId: 'session-1',
        llmRuntime,
        userMessage: '男问桃花',
        activeBoardContext: {
          sourceMessageId: 'board-msg-1',
          skill: 'iching-paipan',
          output: JSON.stringify({
            method: 'manual',
            question: '问感情',
            benGua: { guaName: '地泽临', yaoList: [] },
            zhiGua: { guaName: '地山谦', yaoList: [] },
          }),
          artifactType: 'skill.iching-paipan',
          artifactTitle: '六爻排盘',
          artifactData: {
            method: 'manual',
            question: '问感情',
            benGua: { guaName: '地泽临', yaoList: [] },
            zhiGua: { guaName: '地山谦', yaoList: [] },
          },
        },
        history: [
          {
            role: 'assistant',
            content: '已生成：六爻排盘',
            timestamp: '2026-04-30T10:00:00.000Z',
            toolContext: [
              {
                skill: 'iching-paipan',
                output: JSON.stringify({
                  method: 'manual',
                  question: '问感情',
                  benGua: { guaName: '地泽临', yaoList: [] },
                  zhiGua: { guaName: '地山谦', yaoList: [] },
                }),
                artifactType: 'skill.iching-paipan',
                artifactTitle: '六爻排盘',
                artifactData: {
                  method: 'manual',
                  question: '问感情',
                  benGua: { guaName: '地泽临', yaoList: [] },
                  zhiGua: { guaName: '地山谦', yaoList: [] },
                },
              },
            ],
          },
        ],
      },
      llmRuntime,
      runtime: {
        deps: {
          messageBus: {
            pushOutbox: vi.fn(async () => undefined),
            pushTask: vi.fn(async () => undefined),
          },
        },
        toolRegistry: {
          toolDefinitions: [],
          buildToolPrompts: () => '',
          executeTool: vi.fn(),
          getExecutionMode: () => 'serial',
          getProtectedToolNames: () => new Set<string>(),
        },
      } as never,
      requestScope: createRequestScope(),
    });

    expect(mockRunKernelModelLoop).not.toHaveBeenCalled();
    expect(mockExecuteSpecialist).toHaveBeenCalledTimes(1);
    expect(mockExecuteSpecialist).toHaveBeenCalledWith(
      expect.objectContaining({
        specialist: 'xuanxue-interpret-agent',
        goal: expect.stringContaining('男问桃花'),
        containerInput: expect.objectContaining({
          activeBoardContext: expect.objectContaining({
            skill: 'iching-paipan',
          }),
        }),
      }),
    );
    expect(result.text).toBe('这是桃花解读');
    expect(result.agentGraph.summary.specialistSequence).toEqual([
      'xuanxue-interpret-agent',
    ]);
  });

  it('uses supervisor loop when activeBoardContext is absent', async () => {
    mockRunKernelModelLoop.mockResolvedValueOnce({
      text: 'supervisor result',
      usage: {
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      },
      skillContext: [],
    });

    const result = await executeAgentKernel({
      containerInput: {
        accountId: 'web:user-1',
        sessionId: 'session-1',
        llmRuntime,
        userMessage: '男问桃花',
        history: [],
      },
      llmRuntime,
      runtime: {
        deps: {
          messageBus: {
            pushOutbox: vi.fn(async () => undefined),
            pushTask: vi.fn(async () => undefined),
          },
        },
        toolRegistry: {
          toolDefinitions: [],
          buildToolPrompts: () => '',
          executeTool: vi.fn(),
          getExecutionMode: () => 'serial',
          getProtectedToolNames: () => new Set<string>(),
        },
      } as never,
      requestScope: createRequestScope(),
    });

    expect(mockRunKernelModelLoop).toHaveBeenCalledTimes(1);
    expect(mockExecuteSpecialist).not.toHaveBeenCalled();
    expect(result.text).toBe('supervisor result');
  });

  it('routes valid user pasted board input directly to the interpret specialist', async () => {
    const result = await executeAgentKernel({
      containerInput: {
        accountId: 'web:user-1',
        sessionId: 'session-1',
        llmRuntime,
        userMessage: '请解读我贴的盘',
        inputKind: 'user_pasted_board',
        pastedBoard: {
          category: '六爻',
          content: '用户自贴盘面原文',
          question: '看看事业',
        },
        history: [],
      },
      llmRuntime,
      runtime: {
        deps: {
          messageBus: {
            pushOutbox: vi.fn(async () => undefined),
            pushTask: vi.fn(async () => undefined),
          },
        },
        toolRegistry: {
          toolDefinitions: [],
          buildToolPrompts: () => '',
          executeTool: vi.fn(),
          getExecutionMode: () => 'serial',
          getProtectedToolNames: () => new Set<string>(),
        },
      } as never,
      requestScope: createRequestScope(),
    });

    expect(mockRunKernelModelLoop).not.toHaveBeenCalled();
    expect(mockExecuteSpecialist).toHaveBeenCalledTimes(1);
    expect(mockExecuteSpecialist).toHaveBeenCalledWith(
      expect.objectContaining({
        specialist: 'xuanxue-interpret-agent',
        goal: expect.stringContaining('用户自贴盘面原文'),
      }),
    );
    expect(mockExecuteSpecialist).toHaveBeenCalledWith(
      expect.objectContaining({
        goal: expect.stringContaining('content_source="user"'),
      }),
    );
    expect(result.text).toBe('这是桃花解读');
  });

  it('returns upgrade prompt for valid user pasted board input when interpretation is disabled', async () => {
    mockCreateCapabilityCatalog.mockResolvedValueOnce({
      descriptors: [],
      xuanxueInterpretationEnabled: false,
      boardSkillCatalog: [],
      createRegistryForSpecialist: vi.fn(() => ({
        toolDefinitions: [],
        buildToolPrompts: () => '',
        executeTool: vi.fn(),
        getExecutionMode: () => 'serial',
        getProtectedToolNames: () => new Set<string>(),
      })),
      listSpecialists: () => [],
    });

    const result = await executeAgentKernel({
      containerInput: {
        accountId: 'web:user-1',
        sessionId: 'session-1',
        llmRuntime,
        userMessage: '请解读我贴的盘',
        inputKind: 'user_pasted_board',
        pastedBoard: {
          category: '六爻',
          content: '用户自贴盘面原文',
          question: '看看事业',
        },
        history: [],
      },
      llmRuntime,
      runtime: {
        deps: {
          messageBus: {
            pushOutbox: vi.fn(async () => undefined),
            pushTask: vi.fn(async () => undefined),
          },
        },
        toolRegistry: {
          toolDefinitions: [],
          buildToolPrompts: () => '',
          executeTool: vi.fn(),
          getExecutionMode: () => 'serial',
          getProtectedToolNames: () => new Set<string>(),
        },
      } as never,
      requestScope: createRequestScope(),
    });

    expect(mockRunKernelModelLoop).not.toHaveBeenCalled();
    expect(mockExecuteSpecialist).not.toHaveBeenCalled();
    expect(result.text).toContain('暂不支持玄学专业解读');
  });

  it('rejects user pasted board input without pastedBoard payload before any agent loop', async () => {
    const result = await executeAgentKernel({
      containerInput: {
        accountId: 'web:user-1',
        sessionId: 'session-1',
        llmRuntime,
        userMessage: '请解读我贴的盘',
        inputKind: 'user_pasted_board',
        history: [],
      },
      llmRuntime,
      runtime: {
        deps: {
          messageBus: {
            pushOutbox: vi.fn(async () => undefined),
            pushTask: vi.fn(async () => undefined),
          },
        },
        toolRegistry: {
          toolDefinitions: [],
          buildToolPrompts: () => '',
          executeTool: vi.fn(),
          getExecutionMode: () => 'serial',
          getProtectedToolNames: () => new Set<string>(),
        },
      } as never,
      requestScope: createRequestScope(),
    });

    expect(mockRunKernelModelLoop).not.toHaveBeenCalled();
    expect(mockExecuteSpecialist).not.toHaveBeenCalled();
    expect(result.text).toContain('自贴盘面数据缺失');
  });
});
