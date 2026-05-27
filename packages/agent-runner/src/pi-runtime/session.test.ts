import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCreateAgentSession, mockSessionManager, mockSettingsManager } =
  vi.hoisted(() => ({
    mockCreateAgentSession: vi.fn(),
    mockSessionManager: {
      create: vi.fn(() => ({
        kind: 'session-manager',
        newSession: vi.fn(),
        setSessionFile: vi.fn(),
        isPersisted: vi.fn(() => true),
      })),
      open: vi.fn(() => ({
        kind: 'opened-session-manager',
        isPersisted: vi.fn(() => true),
      })),
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
    },
    skillCatalog: {
      listEffectiveUserSkills: vi.fn(async () => []),
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
    mockSessionManager.create.mockClear();
    mockSessionManager.open.mockClear();
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
        getAppendSystemPrompt(): string[];
        getSystemPrompt(): string;
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

    expect(result.text).toBe('assistant fallback');
    expect(result.usage).toEqual({
      promptTokens: 3,
      completionTokens: 2,
      totalTokens: 5,
    });
    expect(mockCreateAgentSession).toHaveBeenCalledTimes(1);
    expect(mockSessionManager.create).toHaveBeenCalledTimes(1);
    expect(mockSessionManager.open).not.toHaveBeenCalled();
    expect(createArgs.noTools).toBe('all');
    expect(createArgs.tools).toEqual([]);
    expect(createArgs.tools).not.toEqual(expect.arrayContaining(['bazi_paipan']));
    expect(createArgs.tools).not.toEqual(expect.arrayContaining(['read_memory']));
    expect(createArgs.customTools?.map((tool) => tool.name)).toEqual(
      createArgs.tools,
    );
    const visibleSkills = createArgs.resourceLoader?.getSkills().skills ?? [];
    expect(visibleSkills.map((skill) => skill.name)).toEqual([]);
    expect(createArgs.resourceLoader?.getSystemPrompt()).toContain(
      '不要调用或假设存在专用解读工具/解读 Skill',
    );
    expect(capturedPrompt).toBe('基于这个盘继续看事业');
    const appendedContext =
      createArgs.resourceLoader?.getAppendSystemPrompt().join('\n') ?? '';
    expect(appendedContext).toContain('<fateclaw_pi_context>');
    expect(appendedContext).toContain('id="context_provenance"');
    expect(appendedContext).not.toContain('id="session_history"');
    expect(appendedContext).not.toContain('历史八字盘面');
    expect(appendedContext).toContain('id="active_board_context"');
    expect(appendedContext).toContain('当前选中八字盘面');
    expect(appendedContext).toContain('id="pasted_board"');
    expect(appendedContext).toContain('用户自贴八字盘面');
    expect(appendedContext).toContain('id="current_request_metadata"');
    expect(appendedContext).not.toContain('基于这个盘继续看事业');
    expect(result.persistedSkillContext).toEqual([
      expect.objectContaining({
        skill: 'user-pasted-board::八字',
        output: '用户自贴八字盘面',
      }),
    ]);
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
      ]),
    );
  });
});
