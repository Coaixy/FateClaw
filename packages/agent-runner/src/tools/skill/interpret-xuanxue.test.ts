import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../agent-db.js', () => ({
  queryEnabledSkillNames: vi.fn(async () => ['玄学解读']),
  queryEffectiveUserSkills: vi.fn(async () => []),
}));

vi.mock('./board-resolver.js', () => ({
  resolveBoardSourceWithLLM: vi.fn(async () => ({
    selectedSource: 'model_content_fallback',
    reason: 'test',
    confidence: 0.5,
  })),
}));

import { queryEffectiveUserSkills } from '../../agent-db.js';
import { appendArtifact } from '../../artifact-store.js';
import { initContext } from '../../context.js';
import {
  createRequestScope,
  markSkillLoaded,
  setLatestFollowupInterpretation,
} from '../../request-scope.js';
import type { LlmRuntimeSnapshot } from '../../types.js';
import { resolveBoardSourceWithLLM } from './board-resolver.js';
import { executeInterpretXuanxue } from './interpret-xuanxue.js';

function createTextSkillBundle(dirName: string, content: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fateclaw-text-skill-'));
  const bundleDir = path.join(root, dirName);
  fs.mkdirSync(path.join(bundleDir, 'docs'), { recursive: true });
  fs.writeFileSync(
    path.join(bundleDir, 'SKILL.md'),
    [
      '---',
      `name: ${dirName}`,
      `description: ${dirName}`,
      '---',
      '',
      `# ${dirName}`,
    ].join('\n'),
  );
  fs.writeFileSync(path.join(bundleDir, 'docs', 'knowledge.md'), content);
  return bundleDir;
}

function makeLiuyao(position: number, yaoValue: number, isMoving = false) {
  return {
    position,
    yaoValue,
    isMoving,
    tianGan: '己',
    diZhi: ['卯', '巳', '未', '酉', '亥', '丑'][position - 1],
    wuXing: ['木', '火', '土', '金', '水', '土'][position - 1],
    liuQin: ['子孙', '妻财', '官鬼', '父母', '兄弟', '子孙'][position - 1],
    liuShou: ['青龙', '朱雀', '勾陈', '螣蛇', '白虎', '玄武'][position - 1],
    shiYing: position === 1 ? '世' : position === 4 ? '应' : '',
  };
}

const VALID_BOARD_PAYLOAD = {
  method: 'manual',
  question: '测试问题',
  ganZhiYear: { gz: '丙午' },
  ganZhiMonth: { gz: '壬辰' },
  ganZhiDay: { gz: '辛酉' },
  ganZhiHour: { gz: '乙未' },
  dayKong: '子丑',
  hourKong: '辰巳',
  monthJian: '壬辰',
  dongYaoCount: 1,
  benGua: {
    guaName: '既济',
    palace: '坎',
    yaoList: Array.from({ length: 6 }, (_, index) =>
      makeLiuyao(index + 1, index === 2 ? 6 : 7, index === 2),
    ),
  },
  zhiGua: {
    guaName: '随',
    palace: '震',
    yaoList: Array.from({ length: 6 }, (_, index) =>
      makeLiuyao(index + 1, 7, false),
    ),
  },
};

const VALID_BOARD_CONTENT = JSON.stringify(VALID_BOARD_PAYLOAD);

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

function appendOfficialBoardArtifact(
  scope: ReturnType<typeof createRequestScope>,
): void {
  appendArtifact(scope, {
    id: 'artifact-board',
    type: 'skill.iching-paipan',
    title: 'Skill 结果: iching-paipan',
    producer: 'iching-paipan',
    category: '六爻',
    payload: JSON.parse(VALID_BOARD_CONTENT) as Record<string, unknown>,
    rawOutput: VALID_BOARD_CONTENT,
    createdAt: '2026-04-13T00:00:00.000Z',
  });
}

describe('executeInterpretXuanxue main-loop preparation', () => {
  beforeAll(() => {
    process.env.FATECLAW_ACCOUNT_ID = 'test-account';
    process.env.FATECLAW_USER_ID = 'test-user';
    process.env.FATECLAW_TIMEZONE = 'Asia/Shanghai';
    initContext();
  });

  beforeEach(() => {
    vi.mocked(resolveBoardSourceWithLLM).mockClear();
    vi.mocked(queryEffectiveUserSkills).mockReset();
    vi.mocked(queryEffectiveUserSkills).mockImplementation(async () => []);
  });

  it('returns structured board and knowledge material instead of final delivery', async () => {
    const scope = createRequestScope();
    markSkillLoaded(scope, 'xuanxue-jiedu');
    appendOfficialBoardArtifact(scope);

    const result = await executeInterpretXuanxue(
      {
        content: VALID_BOARD_CONTENT,
        category: '六爻',
        question: '看事业',
      },
      {
        requestScope: scope,
        llmRuntime,
      },
    );

    expect(result.isError).toBeFalsy();
    expect(result.delivery).toBeUndefined();
    const parsed = JSON.parse(result.output) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      category: '六爻',
      question: '看事业',
      boardSource: 'current_request_artifact',
    });
    expect(parsed.authoritativeContent).toContain('【六爻排盘 AI摘要】');
    expect(parsed.authoritativeContent).toContain('卦: 既济/坎宫 -> 随/震宫');
    expect(parsed.authoritativeContent).not.toContain('"benGua"');
    const promptTrace = scope.traceEvents.find(
      (event) => event.type === 'interpret_xuanxue_prompt_prepared',
    );
    expect(promptTrace).toMatchObject({
      category: '六爻',
      boardSource: 'current_request_artifact',
      upstreamSkillName: 'iching-paipan',
      runtimePrompt: result.output,
    });
  });

  it('uses current official board artifact when content is omitted', async () => {
    const scope = createRequestScope();
    markSkillLoaded(scope, 'xuanxue-jiedu');
    appendOfficialBoardArtifact(scope);

    const result = await executeInterpretXuanxue(
      {
        category: '六爻',
        question: '看事业',
        content_source: 'skill',
      },
      {
        requestScope: scope,
        llmRuntime,
      },
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.output) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      category: '六爻',
      question: '看事业',
      boardSource: 'current_request_artifact',
    });
    expect(parsed.authoritativeContent).toContain('【六爻排盘 AI摘要】');
    expect(parsed.authoritativeContent).not.toContain('"benGua"');
  });

  it('returns force-injected user knowledge content to the main specialist loop', async () => {
    const flowBundle = createTextSkillBundle(
      'liuyao-flow',
      '## 输出格式\n必须使用【结论】【依据】【建议】三段输出。\n\n## 流程\n先定用神。',
    );
    const moneyBundle = createTextSkillBundle(
      'liuyao-money',
      '## 财运总论\n看财爻。',
    );
    vi.mocked(queryEffectiveUserSkills).mockResolvedValueOnce([
      {
        id: 'skill-flow',
        dir: 'liuyao-flow',
        name: '六爻解卦流程',
        description: '六爻基础流程',
        trigger: '',
        bundle_uri: flowBundle,
        checksum: null,
        install_status: 'installed',
        visibility: 'private',
        category: '六爻',
        category_normalized: '六爻',
        match_keywords: ['六爻'],
        match_patterns: [],
        example_queries: [],
        priority: 0,
        usage_mode: 'force_injected',
        source: 'self',
      },
      {
        id: 'skill-money',
        dir: 'liuyao-money',
        name: '六爻财运专题',
        description: '六爻财运判断',
        trigger: '',
        bundle_uri: moneyBundle,
        checksum: null,
        install_status: 'installed',
        visibility: 'private',
        category: '六爻',
        category_normalized: '六爻',
        match_keywords: ['财运'],
        match_patterns: [],
        example_queries: ['最近会不会破财'],
        priority: 0,
        usage_mode: 'reference_only',
        source: 'self',
      },
    ]);

    const scope = createRequestScope();
    markSkillLoaded(scope, 'xuanxue-jiedu');
    appendOfficialBoardArtifact(scope);

    const result = await executeInterpretXuanxue(
      {
        content: VALID_BOARD_CONTENT,
        category: '六爻',
        question: '最近会不会破财',
      },
      {
        requestScope: scope,
        loopRunId: 'loop-test',
        llmRuntime,
      },
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.output) as {
      userKnowledge: {
        requiredContent?: string;
        forceInjected: Array<{ skill_dir: string }>;
        queryable: Array<{ skill_dir: string; sections: string[] }>;
      };
    };
    expect(parsed.userKnowledge.requiredContent).toContain(
      '必须使用【结论】【依据】【建议】三段输出。',
    );
    expect(parsed.userKnowledge.forceInjected).toEqual([
      expect.objectContaining({ skill_dir: 'liuyao-flow' }),
    ]);
    expect(parsed.userKnowledge.queryable).toEqual([
      expect.objectContaining({
        skill_dir: 'liuyao-money',
        sections: ['财运总论'],
      }),
    ]);
  });

  it('rejects explicit user board content from normal chat without model fallback', async () => {
    const scope = createRequestScope();
    markSkillLoaded(scope, 'xuanxue-jiedu');
    setLatestFollowupInterpretation(scope, {
      category: '六爻',
      interpretationOutput: '上一次结论',
      boardSkill: 'iching-paipan',
      boardOutput: '历史官方原盘',
      boardArtifactData: {
        board: '历史官方原盘',
      },
    });

    const result = await executeInterpretXuanxue(
      {
        content: '用户当前明确贴出的六爻盘面正文',
        content_source: 'user',
        category: '六爻',
        question: '请解读这个盘面',
      },
      {
        requestScope: scope,
        llmRuntime,
      },
    );

    expect(result.isError).toBe(true);
    expect(result.error?.code).toBe('SKILL.CONTENT_MISSING');
    expect(resolveBoardSourceWithLLM).not.toHaveBeenCalled();
  });

  it('uses pasted-board protocol fields over model arguments and artifacts', async () => {
    const scope = createRequestScope();
    markSkillLoaded(scope, 'xuanxue-jiedu');
    appendArtifact(scope, {
      id: 'artifact-1',
      type: 'skill.bazi-paipan',
      title: 'Skill 结果: bazi-paipan',
      producer: 'bazi-paipan',
      category: '八字',
      payload: {
        sizhu: ['甲子', '乙丑', '丙寅', '丁卯'],
      },
      rawOutput: '{"source":"artifact"}',
      createdAt: '2026-04-13T00:00:00.000Z',
    });

    const result = await executeInterpretXuanxue(
      {
        content: '模型改写后的盘面',
        content_source: 'user',
        category: '模型改写类别',
        question: '模型改写问题',
      },
      {
        requestScope: scope,
        inputKind: 'user_pasted_board',
        pastedBoard: {
          category: '六爻',
          content: '用户自贴盘面原文',
          question: '用户原始问题',
        },
        delegationGoal: '委派目标里的其他盘面',
        llmRuntime,
      },
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.output) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      category: '六爻',
      question: '用户原始问题',
      authoritativeContent: '用户自贴盘面原文',
      boardSource: 'explicit_user_board',
    });
    expect(resolveBoardSourceWithLLM).not.toHaveBeenCalled();
  });

  it('accepts normal followup analysis when previous interpretation came from a pasted board', async () => {
    const scope = createRequestScope();
    markSkillLoaded(scope, 'xuanxue-jiedu');
    setLatestFollowupInterpretation(scope, {
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

    const result = await executeInterpretXuanxue(
      {
        question: '继续看事业变化',
      },
      {
        requestScope: scope,
        llmRuntime,
      },
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.output) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      question: expect.stringContaining('继续看事业变化'),
      authoritativeContent: '用户自贴盘面原文',
      boardSource: 'historical_artifact',
      analysisMode: 'followup_delta',
    });
  });

  it('uses the active board skill as the authoritative category when model arguments drift', async () => {
    const scope = createRequestScope();
    markSkillLoaded(scope, 'xuanxue-jiedu');
    const jingzhanBoard = JSON.stringify({
      method: 'manual',
      question: '经占问题',
      benGua: { guaName: '既济', yaoList: [] },
      zhiGua: { guaName: '随', yaoList: [] },
    });

    const result = await executeInterpretXuanxue(
      {
        content: jingzhanBoard,
        content_source: 'skill',
        category: '六爻',
        question: '按这个经占盘看事业',
      },
      {
        requestScope: scope,
        llmRuntime,
        activeBoardContext: {
          sourceMessageId: 'board-msg-jingzhan',
          skill: 'jingzhan-paipan',
          output: jingzhanBoard,
          artifactType: 'skill.jingzhan-paipan',
          artifactTitle: '经占排盘',
          artifactData: JSON.parse(jingzhanBoard) as Record<string, unknown>,
        },
      },
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.output) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      category: '经占',
      question: '按这个经占盘看事业',
      boardSource: 'active_board_context',
    });
    expect(JSON.stringify(parsed)).toContain('既济');
  });
});
