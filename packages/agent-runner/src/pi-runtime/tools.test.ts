import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createSyntheticSourceInfo, type Skill } from '@earendil-works/pi-coding-agent';

const {
  mockExecutePiDeterministicScript,
  mockExecutePiInterpretTool,
  mockExecutePiDirectTool,
} = vi.hoisted(() => ({
  mockExecutePiDeterministicScript: vi.fn(),
  mockExecutePiInterpretTool: vi.fn(),
  mockExecutePiDirectTool: vi.fn(),
}));

vi.mock('./interpret-executor.js', () => ({
  executePiInterpretTool: mockExecutePiInterpretTool,
}));

vi.mock('./deterministic-script-executor.js', () => ({
  executePiDeterministicScript: mockExecutePiDeterministicScript,
}));

vi.mock('./direct-tool-executor.js', () => ({
  executePiDirectTool: mockExecutePiDirectTool,
}));

import { createRequestScope, setRequestId } from '../request-scope.js';
import type { LlmRuntimeSnapshot } from '../types.js';
import { createPiCustomTools } from './tools.js';
import type { RequestRuntime } from '../runtime.js';
import {
  clearXuanxueKnowledgeToolState,
  setXuanxueKnowledgeToolState,
} from '../tools/skill/xuanxue-knowledge-tools.js';
import type { KnowledgeSkillBundle } from '../tools/skill/xuanxue-knowledge.js';

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

function baziPillar(sixtyCycle: string, tenStar: string) {
  return {
    sixtyCycle,
    tenStar,
    heavenStem: { name: sixtyCycle[0], element: '木', yinYang: '阳' },
    earthBranch: {
      name: sixtyCycle[1],
      element: '水',
      hideHeavenStems: [{ name: '癸', type: '正印', element: '水' }],
    },
    terrain: '长生',
    sound: '海中金',
  };
}

const baziBoardOutput = JSON.stringify({
  bazi: {
    birthTime: '1990-01-01 08:00',
    gender: '男',
    baziString: '庚午 丁丑 甲子 戊辰',
    pillars: {
      year: baziPillar('庚午', '七杀'),
      month: baziPillar('丁丑', '伤官'),
      day: baziPillar('甲子', '日主'),
      hour: baziPillar('戊辰', '偏财'),
    },
  },
});

function createRuntime(args: {
  officialSkills?: RequestRuntime['deps']['skillCatalog']['listOfficialSkillMetadata'];
} = {}): RequestRuntime {
  return {
    deps: {
      skillCatalog: {
        listOfficialSkillMetadata:
          args.officialSkills ?? vi.fn(() => []),
      },
    } as unknown as RequestRuntime['deps'],
  };
}

function createReadableSkillFixture(): Skill {
  const skillDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'fateclaw-readable-skill-'),
  );
  const skillFile = path.join(skillDir, 'SKILL.md');
  fs.writeFileSync(
    skillFile,
    [
      '---',
      'name: bazi-paipan',
      'description: 八字排盘',
      '---',
      '',
      '# 八字排盘',
      '',
      '调用 bazi_paipan。',
    ].join('\n'),
  );
  return {
    name: 'bazi-paipan',
    description: '八字排盘',
    filePath: skillFile,
    baseDir: skillDir,
    sourceInfo: createSyntheticSourceInfo(skillFile, {
      source: 'fateclaw-official',
      baseDir: skillDir,
    }),
    disableModelInvocation: false,
  };
}

describe('createPiCustomTools', () => {
  beforeEach(() => {
    mockExecutePiDeterministicScript.mockReset();
    mockExecutePiInterpretTool.mockReset();
    mockExecutePiDirectTool.mockReset();
  });

  it('uses one request-scoped loopRunId for Pi tool calls', async () => {
    const requestScope = createRequestScope();
    setRequestId(requestScope, 'request-1');
    const runtime = createRuntime();
    mockExecutePiDirectTool.mockResolvedValue({
      result: {
        output: 'ok',
      },
    });
    mockExecutePiInterpretTool.mockResolvedValue({
      result: {
        output: 'interpret ok',
      },
    });

    const tools = createPiCustomTools({
      runtime,
      requestScope,
      llmRuntime,
      recordExecution: vi.fn(),
      setFinalReply: vi.fn(),
    });
    await tools
      .find((tool) => tool.name === 'interpret_xuanxue')!
      .execute('call-1', {}, undefined, undefined, undefined as never);
    await tools
      .find((tool) => tool.name === 'read_memory')!
      .execute('call-2', {}, undefined, undefined, undefined as never);

    expect(mockExecutePiInterpretTool.mock.calls[0][0].options.loopRunId).toBe(
      'pi-request-1',
    );
    expect(mockExecutePiDirectTool.mock.calls[0][0].options.loopRunId).toBe(
      'pi-request-1',
    );
    expect(
      mockExecutePiDirectTool.mock.calls[0][0].spec.definition.function.name,
    ).toBe('read_memory');
  });

  it('routes standard utility tools through the Pi direct executor instead of the legacy registry bridge', async () => {
    mockExecutePiDirectTool.mockResolvedValue({
      result: {
        output: 'time ok',
      },
    });

    const tools = createPiCustomTools({
      runtime: createRuntime(),
      requestScope: createRequestScope(),
      llmRuntime,
      recordExecution: vi.fn(),
      setFinalReply: vi.fn(),
    });

    await tools
      .find((tool) => tool.name === 'get_time_detail')!
      .execute(
        'time-call',
        { datetime: '2026-05-26 12:00' },
        undefined,
        undefined,
        undefined as never,
      );

    expect(mockExecutePiDirectTool).toHaveBeenCalledWith(
      expect.objectContaining({
        invocation: expect.objectContaining({
          id: 'time-call',
          toolName: 'get_time_detail',
          args: { datetime: '2026-05-26 12:00' },
        }),
        spec: expect.objectContaining({
          definition: expect.objectContaining({
            function: expect.objectContaining({ name: 'get_time_detail' }),
          }),
        }),
      }),
    );
  });

  it('routes knowledge lookup tools through the Pi direct executor instead of the legacy registry bridge', async () => {
    const requestScope = createRequestScope();
    const loopRunId = 'pi-request';
    const bundle: KnowledgeSkillBundle = {
      skill_dir: 'private-bazi',
      skill_name: '私有八字知识',
      usage_mode: 'reference_only',
      category: '八字',
      source: 'self',
      sections: [
        {
          title: '格局',
          body: '私有正文只应通过授权工具按需读取。',
          level: 2,
          summary: '格局摘要',
        },
      ],
    };
    setXuanxueKnowledgeToolState(loopRunId, { queryable: [bundle] });

    const tools = createPiCustomTools({
      runtime: createRuntime(),
      requestScope,
      llmRuntime,
      recordExecution: vi.fn(),
      setFinalReply: vi.fn(),
    });
    const list = await tools
      .find((tool) => tool.name === 'list_knowledge_sections')!
      .execute('knowledge-list', {}, undefined, undefined, undefined as never);
    const read = await tools
      .find((tool) => tool.name === 'read_knowledge_section')!
      .execute(
        'knowledge-read',
        { skill_dir: 'private-bazi', section_title: '格局' },
        undefined,
        undefined,
        undefined as never,
      );
    const blocked = await tools
      .find((tool) => tool.name === 'read_knowledge_section')!
      .execute(
        'knowledge-blocked',
        { skill_dir: 'other-private', section_title: '格局' },
        undefined,
        undefined,
        undefined as never,
      );
    const blockedDetails = blocked.details as { isError: boolean };

    clearXuanxueKnowledgeToolState(loopRunId);
    expect(list.content[0]).toEqual({
      type: 'text',
      text: expect.stringContaining('private-bazi'),
    });
    expect(read.content[0]).toEqual({
      type: 'text',
      text: expect.stringContaining('私有正文只应通过授权工具按需读取'),
    });
    expect(blockedDetails.isError).toBe(true);
    expect(blocked.content[0]).toEqual({
      type: 'text',
      text: expect.stringContaining('other-private'),
    });
  });

  it('routes interpret_xuanxue through the Pi direct executor instead of the legacy registry bridge', async () => {
    const requestScope = createRequestScope();
    setRequestId(requestScope, 'request-interpret');
    mockExecutePiInterpretTool.mockResolvedValue({
      result: {
        output: '{"authoritativeContent":"ok"}',
      },
    });

    const tools = createPiCustomTools({
      runtime: createRuntime(),
      requestScope,
      llmRuntime,
      recordExecution: vi.fn(),
      setFinalReply: vi.fn(),
    });
    await tools
      .find((tool) => tool.name === 'interpret_xuanxue')!
      .execute(
        'call-interpret',
        { question: '看事业' },
        undefined,
        undefined,
        undefined as never,
      );

    expect(mockExecutePiInterpretTool).toHaveBeenCalledWith(
      expect.objectContaining({
        invocation: expect.objectContaining({
          id: 'call-interpret',
          toolName: 'interpret_xuanxue',
          args: { question: '看事业' },
        }),
        options: expect.objectContaining({
          loopRunId: 'pi-request-interpret',
        }),
      }),
    );
  });

  it('exposes the Pi-owned runtime tools to the model', () => {
    const tools = createPiCustomTools({
      runtime: createRuntime(),
      requestScope: createRequestScope(),
      llmRuntime,
      recordExecution: vi.fn(),
      setFinalReply: vi.fn(),
    });

    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['interpret_xuanxue', 'final_reply']),
    );
  });

  it('uses the Pi-owned tool catalog without requiring a legacy registry snapshot', () => {
    const tools = createPiCustomTools({
      runtime: createRuntime(),
      requestScope: createRequestScope(),
      llmRuntime,
      recordExecution: vi.fn(),
      setFinalReply: vi.fn(),
    });

    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'interpret_xuanxue',
        'list_knowledge_sections',
        'read_knowledge_section',
        'read_memory',
        'get_time_detail',
        'final_reply',
      ]),
    );
  });

  it('adds a scoped read tool for visible official Pi Skills only', async () => {
    const readableSkill = createReadableSkillFixture();
    const recordExecution = vi.fn();
    const tools = createPiCustomTools({
      runtime: createRuntime(),
      requestScope: createRequestScope(),
      llmRuntime,
      readableSkills: [readableSkill],
      recordExecution,
      setFinalReply: vi.fn(),
    });

    expect(tools.map((tool) => tool.name).slice(0, 1)).toEqual(['read']);
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['interpret_xuanxue', 'final_reply']),
    );

    const readTool = tools.find((tool) => tool.name === 'read')!;
    const ok = await readTool.execute(
      'read-1',
      { path: readableSkill.filePath },
      undefined,
      undefined,
      undefined as never,
    );
    const blocked = await readTool.execute(
      'read-2',
      { path: '/Users/example/.pi/skills/private/SKILL.md' },
      undefined,
      undefined,
      undefined as never,
    );
    const blockedDetails = blocked.details as {
      isError: boolean;
      output: string;
    };

    expect(ok.content[0]).toEqual({
      type: 'text',
      text: expect.stringContaining('调用 bazi_paipan'),
    });
    expect(blockedDetails.isError).toBe(true);
    expect(blockedDetails.output).toContain('读取被拒绝');
    expect(recordExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        invocation: expect.objectContaining({ toolName: 'read' }),
        isError: false,
      }),
    );
    expect(recordExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        invocation: expect.objectContaining({ id: 'read-2' }),
        isError: true,
      }),
    );
  });

  it('creates Pi custom tools for enabled deterministic script skills', async () => {
    const requestScope = createRequestScope();
    setRequestId(requestScope, 'request-2');
    mockExecutePiDeterministicScript.mockResolvedValue({
      output: baziBoardOutput,
    });
    const tools = createPiCustomTools({
      runtime: createRuntime(),
      requestScope,
      llmRuntime,
      enabledSkillNames: ['八字排盘'],
      userId: 'user-1',
      recordExecution: vi.fn(),
      setFinalReply: vi.fn(),
    });

    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['bazi_paipan', 'final_reply']),
    );
    await tools
      .find((tool) => tool.name === 'bazi_paipan')!
      .execute(
        'call-1',
        { birthday: '1990-01-01' },
        undefined,
        undefined,
        undefined as never,
      );

    expect(mockExecutePiDeterministicScript).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: expect.objectContaining({
          skillName: 'bazi-paipan',
          script: 'paipan.js',
          displayName: '八字排盘',
        }),
        params: { birthday: '1990-01-01' },
        options: expect.objectContaining({
          loopRunId: 'pi-request-2',
          userId: 'user-1',
        }),
      }),
    );
  });
});
