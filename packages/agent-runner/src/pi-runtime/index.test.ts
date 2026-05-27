import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRunPiSession } = vi.hoisted(() => ({
  mockRunPiSession: vi.fn(),
}));

vi.mock('./session.js', () => ({
  runPiSession: mockRunPiSession,
}));

import { createRequestScope, setRequestId } from '../request-scope.js';
import type {
  Artifact,
  ContainerInput,
  LlmRuntimeSnapshot,
  SkillContextEntry,
} from '../types.js';
import type { RequestRuntime } from '../runtime.js';
import { executePiRuntime } from './index.js';
import type { PiToolExecutionRecord } from './types.js';

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

const runtime = {
  deps: {},
} as RequestRuntime;

function createInput(
  overrides: Partial<ContainerInput> = {},
): ContainerInput {
  return {
    accountId: 'web:user-1',
    sessionId: 'session-1',
    llmRuntime,
    userMessage: '你好',
    history: [],
    ...overrides,
  };
}

function boardContextEntry(
  overrides: Partial<SkillContextEntry> = {},
): SkillContextEntry {
  return {
    skill: 'bazi-paipan',
    output: '{"bazi":"庚午 丁丑 甲子 戊辰"}',
    artifactType: 'skill.bazi-paipan',
    artifactTitle: 'Skill 结果: bazi-paipan',
    artifactData: { bazi: '庚午 丁丑 甲子 戊辰' },
    ...overrides,
  };
}

function boardArtifact(
  overrides: Partial<Artifact> = {},
): Artifact {
  return {
    id: 'board-1',
    type: 'skill.bazi-paipan',
    title: 'Skill 结果: bazi-paipan',
    producer: 'bazi-paipan',
    category: '八字',
    payload: { bazi: '庚午 丁丑 甲子 戊辰' },
    rawOutput: '{"bazi":"庚午 丁丑 甲子 戊辰"}',
    createdAt: '2026-05-26T00:00:00.000Z',
    ...overrides,
  };
}

function interpretContextEntry(
  output = '{"authoritativeContent":"八字解读材料"}',
): SkillContextEntry {
  return {
    skill: 'xuanxue-jiedu',
    output,
    artifactType: 'skill.xuanxue-jiedu',
    artifactTitle: '玄学解读材料',
    artifactData: { authoritativeContent: '八字解读材料' },
  };
}

function record(args: {
  toolName: string;
  output: string;
  modelOutput?: string;
  skillContextEntry?: SkillContextEntry;
  isError?: boolean;
}): PiToolExecutionRecord {
  return {
    invocation: {
      id: `call-${args.toolName}`,
      toolName: args.toolName,
      args: {},
    },
    output: args.output,
    modelOutput: args.modelOutput,
    skillContextEntry: args.skillContextEntry,
    isError: args.isError ?? false,
  };
}

async function runCase(args: {
  input?: ContainerInput;
  records: PiToolExecutionRecord[];
  text?: string;
  artifacts?: Artifact[];
}) {
  const requestScope = createRequestScope();
  setRequestId(requestScope, 'request-1');
  for (const artifact of args.artifacts ?? []) {
    requestScope.artifacts.push(artifact);
  }
  mockRunPiSession.mockResolvedValueOnce({
    text: args.text ?? '最终答复',
    usage: {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    },
    records: args.records,
  });

  return executePiRuntime({
    containerInput: args.input ?? createInput(),
    llmRuntime,
    runtime,
    requestScope,
  });
}

describe('executePiRuntime core workflow graph reconstruction', () => {
  beforeEach(() => {
    mockRunPiSession.mockReset();
  });

  it('handles normal chat without synthetic specialist tasks', async () => {
    const result = await runCase({
      records: [
        record({
          toolName: 'final_reply',
          output: '普通聊天答复',
        }),
      ],
      text: '普通聊天答复',
    });

    expect(result.text).toBe('普通聊天答复');
    expect(result.skillContext).toEqual([]);
    expect(result.agentGraph.summary.specialistSequence).toEqual([]);
    expect(result.agentGraph.summary.finalTextPreview).toBe('普通聊天答复');
  });

  it('reconstructs board generation as a Pi board specialist task', async () => {
    const result = await runCase({
      records: [
        record({
          toolName: 'bazi_paipan',
          output: '{"bazi":"庚午 丁丑 甲子 戊辰"}',
          modelOutput: '八字排盘 AI 摘要',
          skillContextEntry: boardContextEntry(),
        }),
      ],
      artifacts: [boardArtifact()],
    });

    expect(result.skillContext).toEqual([boardContextEntry()]);
    expect(result.agentGraph.summary.specialistSequence).toEqual([
      'xuanxue-board-agent',
    ]);
    expect(result.agentGraph.summary.category).toBe('八字');
    expect(result.agentGraph.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'artifact',
          producer: 'bazi-paipan',
          category: '八字',
        }),
      ]),
    );
  });

  it('keeps board and interpretation context for board then interpretation', async () => {
    const interpretation = interpretContextEntry();
    const result = await runCase({
      records: [
        record({
          toolName: 'bazi_paipan',
          output: '{"bazi":"庚午 丁丑 甲子 戊辰"}',
          modelOutput: '八字排盘 AI 摘要',
          skillContextEntry: boardContextEntry(),
        }),
        record({
          toolName: 'prepare_xuanxue_interpretation',
          output: interpretation.output,
          modelOutput: '解读准备材料',
          skillContextEntry: interpretation,
        }),
      ],
      artifacts: [boardArtifact()],
      text: '完整八字解读',
    });

    expect(result.skillContext).toEqual([boardContextEntry(), interpretation]);
    expect(result.agentGraph.summary.specialistSequence).toEqual([
      'xuanxue-board-agent',
      'xuanxue-interpret-agent',
    ]);
    expect(result.agentGraph.summary.finalTextPreview).toBe('完整八字解读');
  });

  it('treats user pasted board interpretation as an interpretation workflow', async () => {
    const input = createInput({
      inputKind: 'user_pasted_board',
      pastedBoard: {
        category: '六爻',
        content: '用户自贴六爻盘面',
        question: '看感情',
      },
      userMessage: '看感情',
    });
    const interpretation = interpretContextEntry(
      '{"authoritativeContent":"自贴盘面解读材料"}',
    );
    const result = await runCase({
      input,
      records: [
        record({
          toolName: 'prepare_xuanxue_interpretation',
          output: interpretation.output,
          modelOutput: '自贴盘面解读准备材料',
          skillContextEntry: interpretation,
        }),
      ],
      text: '自贴盘面解读',
    });

    expect(result.skillContext).toEqual([interpretation]);
    expect(result.agentGraph.summary.specialistSequence).toEqual([
      'xuanxue-interpret-agent',
    ]);
    expect(mockRunPiSession).toHaveBeenCalledWith(
      expect.objectContaining({
        containerInput: expect.objectContaining({
          inputKind: 'user_pasted_board',
          pastedBoard: expect.objectContaining({ category: '六爻' }),
        }),
      }),
    );
  });

  it('persists Pi context pasted board reference together with interpretation output', async () => {
    const requestScope = createRequestScope();
    setRequestId(requestScope, 'request-1');
    const input = createInput({
      inputKind: 'user_pasted_board',
      pastedBoard: {
        category: '六爻',
        content: '用户自贴六爻盘面',
        question: '看感情',
      },
      userMessage: '看感情',
    });
    const interpretation = interpretContextEntry(
      '{"authoritativeContent":"自贴盘面解读材料"}',
    );
    mockRunPiSession.mockResolvedValueOnce({
      text: '自贴盘面解读',
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      },
      records: [
        record({
          toolName: 'prepare_xuanxue_interpretation',
          output: interpretation.output,
          modelOutput: '自贴盘面解读准备材料',
          skillContextEntry: interpretation,
        }),
      ],
      persistedSkillContext: [
        {
          skill: 'user-pasted-board::六爻',
          output: '用户自贴六爻盘面',
          artifactType: 'skill.user-pasted-board::六爻',
          artifactTitle: '自贴盘面: 六爻',
          artifactData: {
            category: '六爻',
            content: '用户自贴六爻盘面',
            question: '看感情',
            source: 'user_pasted_board',
          },
        },
      ],
    });

    const result = await executePiRuntime({
      containerInput: input,
      llmRuntime,
      runtime,
      requestScope,
    });

    expect(result.skillContext).toEqual([
      expect.objectContaining({
        skill: 'user-pasted-board::六爻',
        output: '用户自贴六爻盘面',
      }),
      interpretation,
    ]);
  });

  it('uses historical board context as graph evidence for follow-up interpretation', async () => {
    const historicalBoard = boardContextEntry({
      output: '历史八字盘面',
      artifactData: { bazi: '历史八字盘面' },
    });
    const input = createInput({
      userMessage: '继续看事业',
      history: [
        {
          role: 'assistant',
          content: '上一轮排盘结果',
          timestamp: '2026-05-25T00:00:00.000Z',
          toolContext: [historicalBoard],
        },
      ],
    });
    const interpretation = interpretContextEntry(
      '{"authoritativeContent":"历史盘面追问材料"}',
    );
    const result = await runCase({
      input,
      records: [
        record({
          toolName: 'prepare_xuanxue_interpretation',
          output: interpretation.output,
          modelOutput: '历史盘面追问准备材料',
          skillContextEntry: interpretation,
        }),
      ],
      text: '历史盘面追问答复',
    });

    expect(result.skillContext).toEqual([interpretation]);
    expect(result.agentGraph.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'history',
          producer: 'bazi-paipan',
          contentPreview: '历史八字盘面',
        }),
      ]),
    );
    expect(result.agentGraph.summary.specialistSequence).toEqual([
      'xuanxue-interpret-agent',
    ]);
  });
});
