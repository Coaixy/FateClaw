import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExecuteInterpretXuanxue } = vi.hoisted(() => ({
  mockExecuteInterpretXuanxue: vi.fn(),
}));

vi.mock('../tools/skill/interpret-xuanxue.js', () => ({
  executeInterpretXuanxue: mockExecuteInterpretXuanxue,
}));

import {
  createRequestScope,
  setLatestFollowupInterpretation,
} from '../request-scope.js';
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
        toolName: 'prepare_xuanxue_interpretation',
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
          toolName: 'prepare_xuanxue_interpretation',
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
          toolName: 'prepare_xuanxue_interpretation',
          piDirectExecutor: true,
        }),
        expect.objectContaining({
          type: 'tool_result',
          toolName: 'prepare_xuanxue_interpretation',
          modelOutputPreview: '模型可读解读材料',
        }),
      ]),
    );
  });

  it('injects followup board and delta context before the interpret tool handler', async () => {
    const requestScope = createRequestScope();
    setLatestFollowupInterpretation(requestScope, {
      category: '六爻',
      interpretationOutput: '上一轮结论',
      boardSkill: 'user-pasted-board::六爻',
      boardOutput: '用户自贴盘面原文',
      boardArtifactData: {
        category: '六爻',
        content: '用户自贴盘面原文',
        question: '原始问题',
        source: 'user_pasted_board',
      },
    });
    const output = JSON.stringify({
      authoritativeContent: '用户自贴盘面原文',
      userKnowledge: { queryable: [] },
    });
    mockExecuteInterpretXuanxue.mockResolvedValue({
      output,
      modelOutput: '追问材料',
    });

    await executePiInterpretTool({
      invocation: {
        id: 'call-followup',
        toolName: 'prepare_xuanxue_interpretation',
        args: {
          question: '继续看事业变化',
          analysis_mode: 'followup_delta',
        },
        source: 'model',
      },
      options: {
        requestScope,
        llmRuntime,
        provider: 'pi-sdk',
        model: llmRuntime.model,
        loopRunId: 'pi-request-followup',
      },
    });

    expect(mockExecuteInterpretXuanxue).toHaveBeenCalledWith(
      expect.objectContaining({
        question: '继续看事业变化',
        analysis_mode: 'followup_delta',
        content: expect.stringContaining('用户自贴盘面原文'),
        content_source: 'pi_context',
        extra_context: expect.stringContaining('上一轮结论'),
      }),
      expect.objectContaining({
        requestScope,
      }),
    );
  });
});
