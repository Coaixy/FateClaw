import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExecuteInterpretXuanxue } = vi.hoisted(() => ({
  mockExecuteInterpretXuanxue: vi.fn(),
}));

vi.mock('../tools/skill/interpret-xuanxue.js', () => ({
  executeInterpretXuanxue: mockExecuteInterpretXuanxue,
}));

import { createRequestScope } from '../request-scope.js';
import type { LlmRuntimeSnapshot } from '../types.js';
import { executePiInterpretTool } from './interpret-executor.js';

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

describe('executePiInterpretTool', () => {
  beforeEach(() => {
    mockExecuteInterpretXuanxue.mockReset();
  });

  it('records transcript, trace, and skill context without the legacy registry bridge', async () => {
    const requestScope = createRequestScope();
    const output = JSON.stringify({
      authoritativeContent: '盘面摘要',
      userKnowledge: { queryable: [] },
    });
    mockExecuteInterpretXuanxue.mockResolvedValue({
      output,
      modelOutput: '模型可读解读材料',
    });

    const result = await executePiInterpretTool({
      invocation: {
        id: 'call-interpret',
        toolName: 'interpret_xuanxue',
        args: { question: '看事业', category: '六爻' },
        source: 'model',
      },
      options: {
        requestScope,
        llmRuntime,
        provider: 'pi-sdk',
        model: llmRuntime.model,
        loopRunId: 'pi-request-1',
      },
    });

    expect(mockExecuteInterpretXuanxue).toHaveBeenCalledWith(
      { question: '看事业', category: '六爻' },
      expect.objectContaining({
        requestScope,
        loopRunId: 'pi-request-1',
      }),
    );
    expect(result.skillContextEntry).toEqual(
      expect.objectContaining({
        skill: 'xuanxue-jiedu',
        output,
        artifactData: expect.objectContaining({
          authoritativeContent: '盘面摘要',
        }),
      }),
    );
    expect(requestScope.transcript).toEqual([
      expect.objectContaining({
        type: 'tool_use',
        invocation: expect.objectContaining({
          toolName: 'interpret_xuanxue',
        }),
      }),
      expect.objectContaining({
        type: 'tool_result',
        invocationId: 'call-interpret',
        output,
        modelOutput: '模型可读解读材料',
      }),
    ]);
    expect(requestScope.traceEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool_call',
          toolName: 'interpret_xuanxue',
          piDirectExecutor: true,
        }),
        expect.objectContaining({
          type: 'tool_result',
          toolName: 'interpret_xuanxue',
          modelOutputPreview: '模型可读解读材料',
        }),
      ]),
    );
  });
});
