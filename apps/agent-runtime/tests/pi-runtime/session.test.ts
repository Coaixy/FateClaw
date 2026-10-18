import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCreateAgentSession, mockSessionManager, mockSettingsManager } =
  vi.hoisted(() => ({
    mockCreateAgentSession: vi.fn(),
    mockSessionManager: {
      create: vi.fn(() => ({
        kind: 'session-manager',
        getSessionId: () => 'synthetic-pi-session',
        newSession: vi.fn(),
        setSessionFile: vi.fn(),
        isPersisted: vi.fn(() => true),
      })),
      open: vi.fn(() => ({
        kind: 'opened-session-manager',
        getSessionId: () => 'synthetic-pi-session',
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

import { createRequestScope } from '#agent/request-scope';
import type { AgentRuntimeDeps } from '#agent/deps';
import type { ContainerInput, LlmRuntimeSnapshot } from '#agent/types';
import type { RequestRuntime } from '#agent/runtime';
import { runPiSession } from '#agent/pi-runtime/session';
import * as streamApi from '#agent/ai-chat-stream';
import { SkillContentCache } from '#agent/skill-content-cache';
import { DEFAULT_BENEFIT_POLICY } from '@fateclaw/contracts/model-settings';
import {
  mapContainerErrorToPublicError,
  ModelCallError,
} from '#agent/public-error';

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
    skillRevisions: { readRevision: vi.fn() },
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
  it('does not contact a model when cancellation arrived before session readiness', async () => {
    const session = {
      state: { messages: [] },
      prompt: vi.fn(async () => {}),
      subscribe: vi.fn(() => vi.fn()),
      abort: vi.fn(async () => {}),
      dispose: vi.fn(),
    };
    mockCreateAgentSession.mockResolvedValueOnce({ session });
    await expect(
      runPiSession({
        containerInput: createInput(),
        runtime: { deps: createDeps() } as RequestRuntime,
        requestScope: createRequestScope(),
        onSessionReady: (controls) => {
          void controls.abort();
        },
      }),
    ).rejects.toThrow('请求已取消');
    expect(session.prompt).not.toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalledOnce();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  beforeEach(() => {
    mockCreateAgentSession.mockReset();
    mockSessionManager.create.mockClear();
    mockSessionManager.open.mockClear();
    mockSettingsManager.inMemory.mockClear();
  });

  it.each(['official', 'benefit'] as const)(
    'returns provider length-stop text consistently for the %s pool',
    async (poolKey) => {
      mockCreateAgentSession.mockResolvedValueOnce({
        session: {
          state: {
            messages: [
              {
                role: 'assistant',
                content: [{ type: 'text', text: 'Synthetic partial answer' }],
                stopReason: 'length',
              },
            ],
          },
          subscribe: () => vi.fn(),
          prompt: vi.fn(async () => {}),
          dispose: vi.fn(),
        },
      });
      const input = createInput();
      input.llmRuntime = {
        ...llmRuntime,
        source: 'official',
        poolKey,
        benefitRequestId:
          poolKey === 'benefit' ? 'synthetic-request' : undefined,
        benefitPolicy:
          poolKey === 'benefit' ? DEFAULT_BENEFIT_POLICY : undefined,
        poolNodes: [{ ...llmRuntime, poolKey, revision: 1, weight: 1 }],
      };
      const result = await runPiSession({
        containerInput: input,
        runtime: { deps: createDeps() },
        requestScope: createRequestScope(),
      });
      expect(result.text).toBe('Synthetic partial answer');
    },
  );

  it('releases skill snapshots when session initialization fails before prompt cleanup is installed', async () => {
    const release = vi.fn();
    vi.spyOn(SkillContentCache.prototype, 'acquire').mockResolvedValue({
      baseDir: '/synthetic/skill',
      filePath: '/synthetic/skill/SKILL.md',
      release,
    });
    const deps = createDeps();
    deps.skillCatalog.listEffectiveUserSkills = vi.fn(async () => [
      {
        id: 'skill-1',
        dir: 'skill-1',
        name: 'Skill',
        description: '',
        bundle_uri: '',
        checksum: 'a'.repeat(64),
        revision_id: 'revision-1',
        format_version: 1,
        install_status: 'installed',
        visibility: 'private',
        source: 'self',
      },
    ]);
    mockCreateAgentSession.mockRejectedValueOnce(
      new Error('synthetic session initialization failure'),
    );
    await expect(
      runPiSession({
        containerInput: createInput(),
        runtime: { deps },
        requestScope: createRequestScope(),
      }),
    ).rejects.toThrow('synthetic session initialization failure');
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    'flushes pending text and disposes on session exit (failure=%s)',
    async (fails) => {
      vi.useFakeTimers();
      const publish = vi
        .spyOn(streamApi, 'publishAiChatStreamEvent')
        .mockResolvedValue();
      let emit: (event: unknown) => void = () => {};
      const unsubscribe = vi.fn();
      const dispose = vi.fn();
      mockCreateAgentSession.mockResolvedValue({
        session: {
          state: { messages: [] },
          subscribe(listener: typeof emit) {
            emit = listener;
            return unsubscribe;
          },
          async prompt() {
            emit({
              type: 'message_update',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'partial' }],
              },
            });
            expect(publish).not.toHaveBeenCalled();
            if (fails) throw new Error('synthetic provider failure');
          },
          dispose,
        },
      });
      const run = runPiSession({
        containerInput: createInput(),
        runtime: { deps: createDeps() },
        requestScope: createRequestScope(),
      });
      if (fails)
        await expect(run).rejects.toThrow('synthetic provider failure');
      else await run;
      expect(publish).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          sessionId: 'session-1',
          event: expect.objectContaining({
            type: 'assistant_delta',
            snapshot: 'partial',
          }),
        }),
      );
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

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
      cacheReadTokens: 7,
      cacheWriteTokens: 11,
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
    expect(mockSettingsManager.inMemory).toHaveBeenCalledWith(
      expect.objectContaining({ cacheWarming: 'off' }),
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

  it('把 Pi assistant 的 Provider 错误转成异常而不是成功空回复', async () => {
    const messages: unknown[] = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: '上一轮正常回复' }],
        stopReason: 'stop',
      },
    ];
    const unsubscribe = vi.fn();
    const dispose = vi.fn();

    mockCreateAgentSession.mockResolvedValue({
      session: {
        state: { messages },
        subscribe() {
          return unsubscribe;
        },
        async prompt() {
          // Pi SDK 对欠费、鉴权等 Provider 错误可能只写终止状态，不会 reject prompt。
          messages.push({
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage: 'HTTP 402: insufficient balance',
            usage: {
              input: 12,
              output: 0,
              totalTokens: 12,
            },
          });
        },
        abort: vi.fn(),
        dispose,
      },
    });

    await expect(
      runPiSession({
        containerInput: createInput(),
        runtime: { deps: createDeps() },
        requestScope: createRequestScope(),
      }),
    ).rejects.toThrow('HTTP 402: insufficient balance');

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('preserves model failure categories through the session instead of reclassifying the public text', async () => {
    const input = createInput();
    input.llmRuntime = {
      ...input.llmRuntime,
      source: 'official',
      poolKey: 'official',
    };
    const messages: unknown[] = [];
    mockCreateAgentSession.mockResolvedValue({
      session: {
        state: { messages },
        subscribe: () => vi.fn(),
        async prompt() {
          messages.push({
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage: '已经净化的用户提示，没有可重新识别的 HTTP 状态码',
            modelFailure: { kinds: ['quota'] },
          });
        },
        abort: vi.fn(),
        dispose: vi.fn(),
      },
    });
    const failure = await runPiSession({
      containerInput: input,
      runtime: { deps: createDeps() },
      requestScope: createRequestScope(),
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ModelCallError);
    expect(
      mapContainerErrorToPublicError(failure, { llmRuntime: input.llmRuntime }),
    ).toMatchObject({
      publicReasonCode: 'model_quota_exhausted',
      publicErrorText: expect.stringContaining('官方模型'),
    });
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
