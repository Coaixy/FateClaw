import { describe, expect, it, vi } from 'vitest';

import { createRequestScope } from '../request-scope.js';
import type { AgentRuntimeDeps } from '../deps.js';
import type { ContainerInput, LlmRuntimeSnapshot } from '../types.js';
import type { RequestRuntime } from '../runtime.js';
import { createPiSessionContext } from './context-layer.js';

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

function createRuntime(): RequestRuntime {
  const deps: AgentRuntimeDeps = {
    memoryStore: {
      read: vi.fn(async () => '用户长期记忆：喜欢简洁结论。'),
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
    activeBoardContext: {
      sourceMessageId: 'message-1',
      skill: 'bazi-paipan',
      output: '当前选中八字盘面',
      artifactType: 'skill.bazi-paipan',
      artifactTitle: '当前选中盘面',
      artifactData: { bazi: '当前选中八字盘面 JSON' },
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
  };
}

describe('createPiSessionContext', () => {
  it('loads first-class Pi context sections with provenance and persisted board context', async () => {
    const requestScope = createRequestScope();
    const runtime = createRuntime();
    const context = await createPiSessionContext({
      containerInput: createInput(),
      runtime,
      requestScope,
    });

    expect(context.prompt).toContain('id="current_request_metadata"');
    expect(context.prompt).not.toContain('继续看事业');
    expect(context.prompt).not.toContain('id="session_history"');
    expect(context.prompt).not.toContain('上一轮解读结论');
    expect(context.prompt).not.toContain('id="historical_tool_context"');
    expect(context.prompt).not.toContain('历史八字盘面');
    expect(context.prompt).not.toContain('id="historical_artifacts"');
    expect(context.prompt).not.toContain('历史八字盘面 JSON');
    expect(context.prompt).toContain('id="active_board_context"');
    expect(context.prompt).toContain('当前选中八字盘面');
    expect(context.prompt).toContain('id="pasted_board"');
    expect(context.prompt).toContain('用户自贴八字盘面');
    expect(context.prompt).toContain('id="followup_context"');
    expect(context.prompt).toContain('数据库里的连续性盘面');
    expect(context.prompt).toContain('id="long_term_memory"');
    expect(context.prompt).toContain('用户长期记忆');
    expect(context.prompt).not.toContain('id="recent_history_store"');
    expect(context.prompt).not.toContain('Redis 历史消息');
    expect(context.prompt).not.toContain('id="knowledge_index"');
    expect(context.prompt).not.toContain('id="required_knowledge_body"');
    expect(context.prompt).toContain('id="context_provenance"');
    expect(context.provenance.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([
        'current_request_metadata',
        'active_board_context',
        'pasted_board',
        'followup_context',
        'long_term_memory',
      ]),
    );
    expect(context.provenance.map((entry) => entry.id)).not.toEqual(
      expect.arrayContaining(['knowledge_index', 'required_knowledge_body']),
    );
    expect(context.persistedSkillContext).toEqual([
      expect.objectContaining({
        skill: 'user-pasted-board::八字',
        output: '用户自贴八字盘面',
      }),
    ]);
    expect(requestScope.latestFollowupInterpretation).toMatchObject({
      category: '八字',
      boardSkill: 'bazi-paipan',
      interpretationOutput: '数据库里的上一轮解读',
    });
  });
});
