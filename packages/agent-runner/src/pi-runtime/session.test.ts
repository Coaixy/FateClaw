import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCreateAgentSession, mockSessionManager, mockSettingsManager } =
  vi.hoisted(() => ({
    mockCreateAgentSession: vi.fn(),
    mockSessionManager: {
      inMemory: vi.fn(() => ({ kind: 'session-manager' })),
    },
    mockSettingsManager: {
      inMemory: vi.fn(() => ({ kind: 'settings-manager' })),
    },
  }));

vi.mock('@earendil-works/pi-coding-agent', async () => {
  const actual =
    await vi.importActual<typeof import('@earendil-works/pi-coding-agent')>(
      '@earendil-works/pi-coding-agent',
    );
  return {
    ...actual,
    createAgentSession: mockCreateAgentSession,
    SessionManager: mockSessionManager,
    SettingsManager: mockSettingsManager,
  };
});

import { createRequestScope } from '../request-scope.js';
import type { AgentRuntimeDeps } from '../deps.js';
import type { ContainerInput, LlmRuntimeSnapshot } from '../types.js';
import type { RequestRuntime } from '../runtime.js';
import { runPiSession } from './session.js';

const llmRuntime: LlmRuntimeSnapshot = {
  source: 'custom',
  billingMode: 'none',
  modelConfigId: 'user-1',
  provider: 'openai-compatible',
  model: 'gpt-4o',
  apiKey: 'request-scoped-key',
  authMode: 'openai_api_key',
  providerKey: 'main-openai',
};

function createDeps(): AgentRuntimeDeps {
  return {
    memoryStore: {
      read: vi.fn(async () => ''),
      write: vi.fn(async () => undefined),
    },
    skillCatalog: {
      listOfficialSkillMetadata: vi.fn(() => []),
      loadOfficialSkillContent: vi.fn(() => null),
      listEnabledSkillNames: vi.fn(async () => ['八字排盘']),
      listEffectiveUserSkills: vi.fn(async () => []),
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
      listRecent: vi.fn(async () => []),
    },
    skillExecutor: {
      execute: vi.fn(async () => ({ stdout: '{}', stderr: '' })),
    },
  };
}

function createInput(): ContainerInput {
  return {
    accountId: 'web:user-1',
    sessionId: 'session-1',
    llmRuntime,
    userMessage: '基于这个盘继续看事业',
    history: [
      {
        role: 'assistant',
        content: '上一轮排盘完成',
        toolContext: [
          {
            skill: 'bazi-paipan',
            output: '历史八字盘面',
          },
        ],
      },
    ],
    activeBoardContext: {
      sourceMessageId: 'message-1',
      skill: 'bazi-paipan',
      output: '当前选中八字盘面',
    },
    inputKind: 'user_pasted_board',
    pastedBoard: {
      category: '八字',
      content: '用户自贴八字盘面',
      question: '看事业',
    },
  };
}

describe('runPiSession', () => {
  beforeEach(() => {
    mockCreateAgentSession.mockReset();
    mockSessionManager.inMemory.mockClear();
    mockSettingsManager.inMemory.mockClear();
  });

  it('creates a Pi AgentSession with request-scoped resources and custom tools', async () => {
    let subscribed:
      | ((event: {
          type: 'turn_end';
          message: {
            role: 'assistant';
            content: string;
            usage: { input: number; output: number };
          };
          toolResults: unknown[];
        }) => void)
      | null = null;
    let capturedPrompt = '';
    let createArgs: {
      noTools?: unknown;
      tools?: string[];
      customTools?: Array<{
        name: string;
        execute(
          toolCallId: string,
          params: { text: string },
        ): Promise<unknown>;
      }>;
      resourceLoader?: {
        getSkills(): { skills: Array<{ name: string; filePath: string }> };
      };
    } = {};

    mockCreateAgentSession.mockImplementation(async (args: typeof createArgs) => {
      createArgs = args;
      return {
        session: {
          state: {
            messages: [],
          },
          subscribe(
            listener: NonNullable<typeof subscribed>,
          ) {
            subscribed = listener;
            return vi.fn();
          },
          async prompt(text: string) {
            capturedPrompt = text;
            subscribed?.({
              type: 'turn_end',
              message: {
                role: 'assistant',
                content: 'assistant fallback',
                usage: { input: 3, output: 2 },
              },
              toolResults: [],
            });
            const finalReply = createArgs.customTools?.find(
              (tool) => tool.name === 'final_reply',
            );
            await finalReply?.execute('final-call', {
              text: 'Pi session 最终回复',
            });
          },
          dispose: vi.fn(),
        },
      };
    });

    const deps = createDeps();
    const runtime: RequestRuntime = { deps };
    const requestScope = createRequestScope();
    const result = await runPiSession({
      containerInput: createInput(),
      runtime,
      requestScope,
    });

    expect(result.text).toBe('Pi session 最终回复');
    expect(result.usage).toEqual({
      promptTokens: 3,
      completionTokens: 2,
      totalTokens: 5,
    });
    expect(mockCreateAgentSession).toHaveBeenCalledTimes(1);
    expect(createArgs.noTools).toBe('all');
    expect(createArgs.tools).toEqual(
      expect.arrayContaining([
        'bazi_paipan',
        'interpret_xuanxue',
        'read_memory',
        'final_reply',
      ]),
    );
    expect(createArgs.customTools?.map((tool) => tool.name)).toEqual(
      createArgs.tools,
    );
    const visibleSkills = createArgs.resourceLoader?.getSkills().skills ?? [];
    expect(visibleSkills.map((skill) => skill.name)).toEqual(['bazi-paipan']);
    expect(visibleSkills.every((skill) => !skill.filePath.includes('.pi'))).toBe(
      true,
    );
    expect(deps.skillCatalog.listEnabledSkillNames).toHaveBeenCalledWith(
      'user-1',
    );
    expect(capturedPrompt).toContain('[最近对话]');
    expect(capturedPrompt).toContain('历史八字盘面');
    expect(capturedPrompt).toContain('[当前选中盘面]');
    expect(capturedPrompt).toContain('当前选中八字盘面');
    expect(capturedPrompt).toContain('[用户自贴盘面入口]');
    expect(capturedPrompt).toContain('用户自贴八字盘面');
    expect(capturedPrompt).toContain('[本轮用户消息]');
    expect(capturedPrompt).toContain('基于这个盘继续看事业');
    expect(requestScope.traceEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'pi_session_started',
          builtinToolsDisabled: true,
        }),
        expect.objectContaining({
          type: 'pi_turn_end',
          toolResultCount: 0,
        }),
        expect.objectContaining({
          type: 'pi_final_reply',
          textLength: 15,
        }),
      ]),
    );
  });
});
