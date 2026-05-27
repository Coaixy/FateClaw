import { describe, expect, it, vi } from 'vitest';

import { createRequestScope } from '../request-scope.js';
import type { AgentRuntimeDeps } from '../deps.js';
import type { EffectiveUserSkill } from '../agent-db.js';
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
  const effectiveUserSkills: EffectiveUserSkill[] = [
    {
      id: 'force-knowledge',
      dir: 'force-bazi',
      name: '八字必读知识',
      description: '必须注入的八字规则',
      trigger: '八字',
      bundle_uri: '/unused',
      checksum: null,
      install_status: 'installed',
      visibility: 'private',
      category: '八字',
      category_normalized: '八字',
      match_keywords: ['格局'],
      match_patterns: [],
      example_queries: [],
      priority: 10,
      usage_mode: 'force_injected',
      source: 'self',
    },
    {
      id: 'reference-knowledge',
      dir: 'ref-bazi',
      name: '八字参考知识',
      description: '按需读取的八字规则',
      trigger: '财运',
      bundle_uri: '/unused',
      checksum: null,
      install_status: 'installed',
      visibility: 'private',
      category: '八字',
      category_normalized: '八字',
      match_keywords: ['财运'],
      match_patterns: [],
      example_queries: ['看财运'],
      priority: 5,
      usage_mode: 'reference_only',
      source: 'self',
    },
  ];
  const deps: AgentRuntimeDeps = {
    memoryStore: {
      read: vi.fn(async () => '用户长期记忆：喜欢简洁结论。'),
      write: vi.fn(async () => undefined),
    },
    skillCatalog: {
      listOfficialSkillMetadata: vi.fn(() => []),
      loadOfficialSkillContent: vi.fn(() => null),
      listEnabledSkillNames: vi.fn(async () => []),
      listEffectiveUserSkills: vi.fn(async () => effectiveUserSkills),
      readTextSkillBundle: vi.fn(async () => '必须遵守的知识库正文。'),
      toggleUserSkill: vi.fn(async () => undefined),
    },
    taskStore: {
      list: vi.fn(async () => []),
    },
    messageBus: {
      pushOutbox: vi.fn(async () => undefined),
      pushTask: vi.fn(async () => undefined),
    },
    historyStore: {
      listRecent: vi.fn(async () => [
        JSON.stringify({
          sender_name: 'User',
          content: 'Redis 历史消息',
          timestamp: '2026-05-26T00:00:00.000Z',
          is_from_me: false,
        }),
      ]),
    },
    workflowContextStore: {
      latestFollowupContext: vi.fn(async () => null),
    },
    skillExecutor: {
      execute: vi.fn(async () => ({ stdout: '{}', stderr: '' })),
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
          {
            skill: 'xuanxue-jiedu',
            output: '上一轮解读结论',
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
      userId: 'user-1',
    });

    expect(context.prompt).toContain('id="current_request_metadata"');
    expect(context.prompt).not.toContain('继续看事业');
    expect(context.prompt).toContain('id="session_history"');
    expect(context.prompt).toContain('上一轮解读');
    expect(context.prompt).toContain('id="historical_tool_context"');
    expect(context.prompt).toContain('历史八字盘面');
    expect(context.prompt).toContain('id="historical_artifacts"');
    expect(context.prompt).toContain('历史八字盘面 JSON');
    expect(context.prompt).toContain('id="active_board_context"');
    expect(context.prompt).toContain('当前选中八字盘面');
    expect(context.prompt).toContain('id="pasted_board"');
    expect(context.prompt).toContain('用户自贴八字盘面');
    expect(context.prompt).toContain('id="long_term_memory"');
    expect(context.prompt).toContain('用户长期记忆');
    expect(context.prompt).toContain('id="recent_history_store"');
    expect(context.prompt).toContain('Redis 历史消息');
    expect(context.prompt).toContain('id="knowledge_index"');
    expect(context.prompt).toContain('ref-bazi');
    expect(context.prompt).toContain('id="required_knowledge_body"');
    expect(context.prompt).toContain('必须遵守的知识库正文');
    expect(context.prompt).toContain('id="context_provenance"');
    expect(context.provenance.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([
        'current_request_metadata',
        'session_history',
        'historical_tool_context',
        'historical_artifacts',
        'active_board_context',
        'pasted_board',
        'long_term_memory',
        'recent_history_store',
        'knowledge_index',
        'required_knowledge_body',
      ]),
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
      interpretationOutput: '上一轮解读结论',
    });
  });
});
