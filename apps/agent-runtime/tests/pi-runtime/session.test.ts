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
  const actual = await vi.importActual<
    typeof import('@earendil-works/pi-coding-agent')
  >('@earendil-works/pi-coding-agent');
  return {
    ...actual,
    createAgentSession: mockCreateAgentSession,
    SessionManager: mockSessionManager,
    SettingsManager: mockSettingsManager,
  };
});

import { createRequestScope } from '../../src/request-scope.js';
import type { AgentRuntimeDeps } from '../../src/deps.js';
import type { ContainerInput, LlmRuntimeSnapshot } from '../../src/types.js';
import type { RequestRuntime } from '../../src/runtime.js';
import { runPiSession } from '../../src/pi-runtime/session.js';

const llmRuntime: LlmRuntimeSnapshot = {
  source: 'custom',
  billingMode: 'none',
  modelConfigId: 'user-1',
  piApi: 'openai-completions',
  model: 'gpt-4o',
  apiKey: 'request-scoped-key',
  authMode: 'openai_api_key',
  providerKey: 'main-openai',
};

function createDeps(): AgentRuntimeDeps {
  return {
    soulStore: {
      read: vi.fn(async () => ''),
      canEdit: vi.fn(async () => true),
      update: vi.fn(),
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
    inputKind: 'user_pasted_board',
    pastedBoard: {
      category: '八字',
      content: '用户自贴八字盘面',
      question: '看事业',
    },
    sessionBoardContexts: [
      {
        sourceMessageId: 'message-1',
        source: 'official_paipan',
        skill: 'bazi-paipan',
        promptText: '当前选中八字盘面',
        isCurrent: true,
      },
      {
        sourceMessageId: 'message-2',
        source: 'user_pasted_board',
        skill: 'user-pasted-board::八字',
        artifactTitle: '自贴盘面: 八字',
        promptText: '用户自贴八字盘面',
        isCurrent: false,
      },
    ],
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
            usage: {
              input: number;
              output: number;
              cacheRead?: number;
              cacheWrite?: number;
              totalTokens?: number;
            };
          };
          toolResults: unknown[];
        }) => void)
      | null = null;
    let capturedPrompt = '';
    const abort = vi.fn(async () => {});
    const onSessionReady = vi.fn();
    let createArgs: {
      noTools?: unknown;
      tools?: string[];
      customTools?: Array<{
        name: string;
        execute(toolCallId: string, params: { text: string }): Promise<unknown>;
      }>;
      model?: {
        reasoning?: boolean;
      };
      thinkingLevel?: unknown;
      resourceLoader?: {
        getSkills(): { skills: Array<{ name: string; filePath: string }> };
        getAppendSystemPrompt(): string[];
        getSystemPrompt(): string;
      };
    } = {};

    mockCreateAgentSession.mockImplementation(
      async (args: typeof createArgs) => {
        createArgs = args;
        return {
          session: {
            state: {
              messages: [],
            },
            subscribe(listener: NonNullable<typeof subscribed>) {
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
                  usage: {
                    input: 3,
                    output: 2,
                    cacheRead: 7,
                    cacheWrite: 11,
                    totalTokens: 23,
                  },
                },
                toolResults: [],
              });
            },
            abort,
            dispose: vi.fn(),
          },
        };
      },
    );

    const deps = createDeps();
    const runtime: RequestRuntime = { deps };
    const requestScope = createRequestScope();
    const result = await runPiSession({
      containerInput: createInput(),
      runtime,
      requestScope,
      onSessionReady,
    });

    expect(onSessionReady).toHaveBeenCalledTimes(1);
    await onSessionReady.mock.calls[0][0].abort();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('assistant fallback');
    expect(result.usage).toEqual({
      promptTokens: 21,
      completionTokens: 2,
      totalTokens: 23,
    });
    expect(result.piSession).toMatchObject({
      id: 'session-1',
      persisted: true,
      provider: 'openai-completions',
      model: 'gpt-4o',
      userPrompt: '基于这个盘继续看事业',
      systemPrompt: expect.stringContaining(
        'FateClaw 的 Pi-backed Agent Runtime',
      ),
      allowedTools: [
        'get_current_time',
        'get_ganzhi_by_datetime',
        'reverse_ganzhi',
        'read_soul',
        'edit_soul',
        'get_session_board',
      ],
      readableSkills: [],
      messageCount: 0,
    });
    expect(result.piSession?.appendSystemPrompt.join('\n')).toContain(
      '<fateclaw_pi_context>',
    );
    expect(result.piSession?.appendSystemPrompt.join('\n')).toContain(
      '当前选中八字盘面',
    );
    expect(mockCreateAgentSession).toHaveBeenCalledTimes(1);
    expect(mockSessionManager.create).toHaveBeenCalledTimes(1);
    expect(mockSessionManager.open).not.toHaveBeenCalled();
    expect(createArgs.model?.reasoning).toBe(true);
    expect(createArgs.thinkingLevel).toBe('medium');
    expect(createArgs.noTools).toBe('all');
    expect(createArgs.tools).toEqual([
      'get_current_time',
      'get_ganzhi_by_datetime',
      'reverse_ganzhi',
      'read_soul',
      'edit_soul',
      'get_session_board',
    ]);
    expect(createArgs.tools).not.toEqual(
      expect.arrayContaining(['bazi_paipan']),
    );
    expect(createArgs.tools).not.toEqual(
      expect.arrayContaining(['read_memory']),
    );
    expect(createArgs.customTools?.map((tool) => tool.name)).toEqual(
      createArgs.tools,
    );
    const visibleSkills = createArgs.resourceLoader?.getSkills().skills ?? [];
    expect(visibleSkills.map((skill) => skill.name)).toEqual([]);
    expect(createArgs.resourceLoader?.getSystemPrompt()).toContain(
      '可读取本轮授权的 Markdown Skill 作为方法和知识依据',
    );
    expect(capturedPrompt).toBe('基于这个盘继续看事业');
    const appendedContext =
      createArgs.resourceLoader?.getAppendSystemPrompt().join('\n') ?? '';
    expect(appendedContext).toContain('<fateclaw_pi_context>');
    expect(appendedContext).toContain('id="context_manifest"');
    expect(appendedContext).not.toContain('id="session_history"');
    expect(appendedContext).not.toContain('历史八字盘面');
    expect(appendedContext).not.toContain('id="active_board_context"');
    expect(appendedContext).toContain('id="session_board_manifest"');
    expect(appendedContext).toContain('本会话包含 2 个已授权盘面');
    expect(appendedContext).toContain('必须先调用 get_session_board');
    expect(appendedContext).toContain('当前选中八字盘面');
    expect(appendedContext).not.toContain('id="pasted_board"');
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

  it('on abort returns the current-turn partial, not a reused-session prior reply', async () => {
    let subscribed:
      | ((event: {
          type: 'message_update';
          message: { role: 'assistant'; content: string };
        }) => void)
      | null = null;
    let abortControl: (() => Promise<void>) | null = null;
    const innerAbort = vi.fn(async () => {});
    const onSessionReady = vi.fn(
      (controls: { abort: () => Promise<void> }) => {
        abortControl = controls.abort;
      },
    );

    mockCreateAgentSession.mockImplementation(async () => ({
      session: {
        // 复用的 Pi 会话里残留着上一回合的 assistant 回复
        state: { messages: [{ role: 'assistant', content: '上一回合的回复' }] },
        subscribe(listener: NonNullable<typeof subscribed>) {
          subscribed = listener;
          return vi.fn();
        },
        async prompt() {
          // 当前回合先流式产出部分内容
          subscribed?.({
            type: 'message_update',
            message: { role: 'assistant', content: '当前回合的部分内容' },
          });
          // 用户中断:触发 abort 控制(置 aborted 标志),随后 prompt 因 abort 抛出
          await abortControl?.();
          throw new Error('aborted by user');
        },
        abort: innerAbort,
        dispose: vi.fn(),
      },
    }));

    const deps = createDeps();
    const runtime: RequestRuntime = { deps };
    const requestScope = createRequestScope();
    const result = await runPiSession({
      containerInput: createInput(),
      runtime,
      requestScope,
      onSessionReady,
    });

    // 关键:中断返回「当前回合」的 partial,绝不取复用会话里上一回合的回复。
    expect(result.text).toBe('当前回合的部分内容');
    expect(result.text).not.toBe('上一回合的回复');
    expect(innerAbort).toHaveBeenCalledTimes(1);
  });

  it('on success with no current-turn output does not leak a reused-session prior reply', async () => {
    mockCreateAgentSession.mockImplementation(async () => ({
      session: {
        // 复用的 Pi 会话里残留上一回合的 assistant 回复
        state: { messages: [{ role: 'assistant', content: '上一回合的回复' }] },
        subscribe() {
          return vi.fn();
        },
        // 本回合正常完成,但未产出任何 assistant 文本(无 turn_end/message_update 文本事件)
        async prompt() {},
        abort: vi.fn(),
        dispose: vi.fn(),
      },
    }));

    const deps = createDeps();
    const runtime: RequestRuntime = { deps };
    const requestScope = createRequestScope();
    const result = await runPiSession({
      containerInput: createInput(),
      runtime,
      requestScope,
    });

    // 本回合无产出 → text 为 null,绝不回退到复用会话里上一回合的回复。
    expect(result.text).toBeNull();
  });

  it('injects the no-board policy for normal chat without authorized board context', async () => {
    const userMessage = '我是 1990-01-01 早上八点出生，帮我排盘看事业';
    let capturedPrompt = '';
    let createArgs: {
      tools?: string[];
      resourceLoader?: {
        getAppendSystemPrompt(): string[];
      };
    } = {};

    mockCreateAgentSession.mockImplementation(
      async (args: typeof createArgs) => {
        createArgs = args;
        return {
          session: {
            state: {
              messages: [],
            },
            subscribe() {
              return vi.fn();
            },
            async prompt(text: string) {
              capturedPrompt = text;
            },
            abort: vi.fn(),
            dispose: vi.fn(),
          },
        };
      },
    );

    const runtime: RequestRuntime = { deps: createDeps() };
    const result = await runPiSession({
      containerInput: {
        accountId: 'web:user-1',
        sessionId: 'session-no-board',
        llmRuntime,
        userMessage,
        history: [],
      },
      runtime,
      requestScope: createRequestScope(),
    });

    const appendedContext =
      createArgs.resourceLoader?.getAppendSystemPrompt().join('\n') ?? '';

    expect(capturedPrompt).toBe(userMessage);
    expect(appendedContext).toContain('id="board_absence_policy"');
    expect(appendedContext).toContain('本轮没有授权盘面材料');
    expect(appendedContext).toContain('不要自行计算或生成盘面');
    expect(appendedContext).toContain('FateClaw Web/API 的专用排盘入口');
    expect(appendedContext).not.toContain('id="session_board_manifest"');
    expect(appendedContext).not.toContain(userMessage);
    expect(createArgs.tools).toEqual([
      'get_current_time',
      'get_ganzhi_by_datetime',
      'reverse_ganzhi',
      'read_soul',
      'edit_soul',
    ]);
    expect(result.piSession?.appendSystemPrompt.join('\n')).toContain(
      'id="board_absence_policy"',
    );
  });

  it('does not register edit_soul when conversation Soul edits are disabled', async () => {
    let createArgs: {
      tools?: string[];
      customTools?: Array<{ name: string }>;
      resourceLoader?: {
        getSystemPrompt(): string;
      };
    } = {};

    mockCreateAgentSession.mockImplementation(
      async (args: typeof createArgs) => {
        createArgs = args;
        return {
          session: {
            state: {
              messages: [],
            },
            subscribe() {
              return vi.fn();
            },
            async prompt() {},
            abort: vi.fn(),
            dispose: vi.fn(),
          },
        };
      },
    );

    const deps = createDeps();
    vi.mocked(deps.soulStore.canEdit).mockResolvedValue(false);
    const runtime: RequestRuntime = { deps };
    await runPiSession({
      containerInput: createInput(),
      runtime,
      requestScope: createRequestScope(),
    });

    expect(createArgs.tools).toEqual([
      'get_current_time',
      'get_ganzhi_by_datetime',
      'reverse_ganzhi',
      'read_soul',
      'get_session_board',
    ]);
    expect(createArgs.customTools?.map((tool) => tool.name)).toEqual(
      createArgs.tools,
    );
    expect(createArgs.resourceLoader?.getSystemPrompt()).toContain(
      '本轮不会提供 edit_soul',
    );
  });
});
