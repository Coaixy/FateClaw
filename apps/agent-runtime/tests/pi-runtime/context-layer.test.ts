import { describe, expect, it, vi } from 'vitest';

import { createRequestScope } from '../../src/request-scope.js';
import type { AgentRuntimeDeps } from '../../src/deps.js';
import type { ContainerInput, LlmRuntimeSnapshot } from '../../src/types.js';
import type { RequestRuntime } from '../../src/runtime.js';
import { createPiSessionContext } from '../../src/pi-runtime/context-layer.js';

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

function createRuntime(): RequestRuntime {
  const deps: AgentRuntimeDeps = {
    soulStore: {
      read: vi.fn(async () => '用户 Soul：喜欢简洁结论。'),
      canEdit: vi.fn(async () => true),
      update: vi.fn(),
    },
    skillCatalog: {
      listEffectiveUserSkills: vi.fn(async () => []),
    },
    workflowContextStore: {
      latestFollowupContext: vi.fn(async () => ({
        category: '八字',
        boardSkill: 'bazi-paipan',
        boardOutput: '数据库里的连续性盘面',
        boardArtifactData: { bazi: '数据库里的盘面 JSON' },
        interpretationOutput: '数据库里的上一轮解读',
      })),
    },
  };
  return { deps };
}

function createInput(): ContainerInput {
  return {
    accountId: 'web:user-1',
    sessionId: 'session-1',
    llmRuntime,
    userMessage: '继续看事业',
    inputKind: 'user_pasted_board',
    pastedBoard: {
      category: '八字',
      content: '用户自贴八字盘面',
      question: '看事业',
    },
    history: [
      {
        role: 'assistant',
        content: '上一轮解读',
        timestamp: '2026-05-25T00:00:00.000Z',
        toolContext: [
          {
            skill: 'bazi-paipan',
            output: '历史八字盘面',
            artifactType: 'skill.bazi-paipan',
            artifactTitle: '历史盘面',
            artifactData: { bazi: '历史八字盘面 JSON' },
          },
        ],
      },
    ],
    sessionBoardContexts: [
      {
        sourceMessageId: 'message-1',
        source: 'official_paipan',
        skill: 'bazi-paipan',
        artifactTitle: '当前选中盘面',
        promptText: '当前选中八字盘面',
        artifactData: { bazi: '当前选中八字盘面 JSON' },
        createdAt: '2026-05-25T00:00:00.000Z',
        isCurrent: true,
      },
      {
        sourceMessageId: 'message-2',
        source: 'user_pasted_board',
        skill: 'user-pasted-board::八字',
        artifactTitle: '自贴盘面: 八字',
        promptText: '用户自贴八字盘面',
        artifactData: {
          category: '八字',
          content: '用户自贴八字盘面',
          question: '看事业',
          source: 'user_pasted_board',
        },
        createdAt: '2026-05-25T00:01:00.000Z',
        isCurrent: false,
      },
    ],
  };
}

describe('createPiSessionContext', () => {
  it('loads first-class Pi context manifest sections and persisted board context', async () => {
    const requestScope = createRequestScope();
    const runtime = createRuntime();
    const context = await createPiSessionContext({
      containerInput: createInput(),
      runtime,
      requestScope,
    });

    expect(context.prompt).toContain('id="current_request_metadata"');
    expect(context.prompt).not.toContain('继续看事业');
    expect(context.prompt).not.toContain('id="board_absence_policy"');
    expect(context.prompt).not.toContain('id="session_history"');
    expect(context.prompt).not.toContain('上一轮解读结论');
    expect(context.prompt).not.toContain('id="historical_tool_context"');
    expect(context.prompt).not.toContain('历史八字盘面');
    expect(context.prompt).not.toContain('id="historical_artifacts"');
    expect(context.prompt).not.toContain('历史八字盘面 JSON');
    expect(context.prompt).not.toContain('id="active_board_context"');
    expect(context.prompt).toContain('id="session_board_manifest"');
    expect(context.prompt).toContain('本会话包含 2 个已授权盘面');
    expect(context.prompt).toContain('必须先调用 get_session_board');
    expect(context.prompt).toContain(
      '<board index="1" current="true" source="official_paipan"',
    );
    expect(context.prompt).toContain('当前选中八字盘面');
    expect(context.prompt).not.toContain('id="pasted_board"');
    expect(context.prompt).toContain(
      '<board index="2" current="false" source="user_pasted_board"',
    );
    expect(context.prompt).toContain('用户自贴八字盘面');
    expect(context.prompt).toContain('用户提供的数据材料');
    expect(context.prompt).not.toContain('当前选中八字盘面 JSON');
    expect(context.prompt).not.toContain('id="followup_context"');
    expect(context.prompt).not.toContain('数据库里的连续性盘面');
    expect(context.prompt).not.toContain('数据库里的盘面 JSON');
    expect(context.prompt).not.toContain('数据库里的上一轮解读');
    expect(context.prompt).toContain('id="soul_manifest"');
    expect(context.prompt).toContain('用户 Soul 清单');
    expect(context.prompt).not.toContain('id="recent_history_store"');
    expect(context.prompt).not.toContain('Redis 历史消息');
    expect(context.prompt).not.toContain('id="knowledge_index"');
    expect(context.prompt).not.toContain('id="required_knowledge_body"');
    expect(context.prompt).toContain('id="context_manifest"');
    expect(context.manifest.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([
        'current_request_metadata',
        'session_board_manifest',
        'soul_manifest',
      ]),
    );
    expect(context.manifest.map((entry) => entry.id)).not.toEqual(
      expect.arrayContaining(['knowledge_index', 'required_knowledge_body']),
    );
    expect(context.persistedSkillContext).toEqual([
      expect.objectContaining({
        skill: 'user-pasted-board::八字',
        output: '用户自贴八字盘面',
      }),
    ]);
    expect(
      runtime.deps.workflowContextStore?.latestFollowupContext,
    ).not.toHaveBeenCalled();
    expect(requestScope.latestFollowupInterpretation).toBeNull();
  });

  it('keeps long board facts behind get_session_board instead of injecting full prompt text', async () => {
    const requestScope = createRequestScope();
    const longBoard = [
      '长盘面开头',
      '甲'.repeat(400),
      '中段唯一内容不应进入 system prompt',
      '乙'.repeat(400),
      '长盘面结尾',
    ].join('\n');
    const context = await createPiSessionContext({
      containerInput: {
        accountId: 'web:user-1',
        sessionId: 'session-long-board',
        llmRuntime,
        userMessage: '继续看这个盘',
        history: [],
        sessionBoardContexts: [
          {
            sourceMessageId: 'message-long',
            source: 'official_paipan',
            skill: 'bazi-paipan',
            artifactTitle: '长盘面',
            promptText: longBoard,
            isCurrent: true,
          },
        ],
      },
      runtime: createRuntime(),
      requestScope,
    });

    expect(context.prompt).toContain('id="session_board_manifest"');
    expect(context.prompt).toContain('previewTruncated=true');
    expect(context.prompt).toContain('必须先调用 get_session_board');
    expect(context.prompt).toContain('长盘面开头');
    expect(context.prompt).not.toContain('中段唯一内容不应进入 system prompt');
  });

  it('injects a no-board policy when no authorized board context is visible', async () => {
    const requestScope = createRequestScope();
    const context = await createPiSessionContext({
      containerInput: {
        accountId: 'web:user-1',
        sessionId: 'session-1',
        llmRuntime,
        userMessage: '我是 1990-01-01 早上八点出生，帮我排盘看事业',
        history: [],
      },
      runtime: {
        deps: {
          soulStore: {
            read: vi.fn(async () => ''),
            canEdit: vi.fn(async () => true),
            update: vi.fn(),
          },
          skillCatalog: {
            listEffectiveUserSkills: vi.fn(async () => []),
          },
        },
      },
      requestScope,
    });

    expect(context.prompt).toContain('id="board_absence_policy"');
    expect(context.prompt).toContain('本轮没有授权盘面材料');
    expect(context.prompt).toContain('不等于已授权的盘面 artifact');
    expect(context.prompt).toContain('不要自行计算或生成盘面');
    expect(context.prompt).toContain('FateClaw Web/API 的专用排盘入口');
    expect(context.prompt).not.toContain('id="session_board_manifest"');
    expect(context.prompt).not.toContain(
      '我是 1990-01-01 早上八点出生，帮我排盘看事业',
    );
    expect(context.manifest.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([
        'current_request_metadata',
        'board_absence_policy',
      ]),
    );
  });
});
