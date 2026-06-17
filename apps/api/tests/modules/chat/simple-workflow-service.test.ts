import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCreateChatSession,
  mockExecuteDirectPaipan,
  mockGetDefaultSimpleWorkflowPreset,
  mockResolveSimpleWorkflowLlmRuntime,
  mockSendOwnedChatSessionMessage,
  mockStoreMessage,
  mockTouchChatSession,
} = vi.hoisted(() => ({
  mockCreateChatSession: vi.fn(),
  mockExecuteDirectPaipan: vi.fn(),
  mockGetDefaultSimpleWorkflowPreset: vi.fn(),
  mockResolveSimpleWorkflowLlmRuntime: vi.fn(),
  mockSendOwnedChatSessionMessage: vi.fn(),
  mockStoreMessage: vi.fn(),
  mockTouchChatSession: vi.fn(),
}));

vi.mock('../../../src/infrastructure/db.js', () => ({
  createChatSession: mockCreateChatSession,
  getDefaultSimpleWorkflowPreset: mockGetDefaultSimpleWorkflowPreset,
  storeMessage: mockStoreMessage,
  touchChatSession: mockTouchChatSession,
}));

vi.mock('../../../src/infrastructure/logger.js', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../../../src/modules/system/system-config.js', () => ({
  resolveSimpleWorkflowLlmRuntime: mockResolveSimpleWorkflowLlmRuntime,
}));

vi.mock('../../../src/modules/chat/chat-session-service.js', () => ({
  sendOwnedChatSessionMessage: mockSendOwnedChatSessionMessage,
}));

vi.mock('../../../src/modules/chat/paipan-runtime.js', () => ({
  DirectPaipanError: class DirectPaipanError extends Error {
    constructor(
      public code: string,
      message: string,
      public statusCode: number,
    ) {
      super(message);
    }
  },
  executeDirectPaipan: mockExecuteDirectPaipan,
}));

import { startSimpleWorkflowForOwnedUser } from '../../../src/modules/chat/simple-workflow-service.js';

const divinationPreset = {
  id: 'simple-divination-default',
  kind: 'divination' as const,
  name: '默认占卜问事',
  enabled: true,
  is_default: true,
  entry_title: '占卜问事',
  entry_description: 'desc',
  paipan_skill: 'iching-paipan' as const,
  paipan_input_defaults: { method: 'dayan' },
  model_policy: {
    mode: 'user-current' as const,
    thinkingLevel: 'medium' as const,
  },
  skill_bundle_ids: ['bundle-liuyao'],
  skill_ids: ['skill-liuyao'],
  skill_snapshot_ids: ['snapshot-liuyao'],
  prompt_template: '占卜模板',
  sort_order: 10,
  created_at: '2026-06-09T00:00:00.000Z',
  updated_at: '2026-06-09T00:00:00.000Z',
};

const natalPreset = {
  ...divinationPreset,
  id: 'simple-natal-default',
  kind: 'natal' as const,
  name: '默认命理分析',
  entry_title: '命理分析',
  paipan_skill: 'bazi-paipan' as const,
  paipan_input_defaults: { include: ['bazi', 'fortune', 'pattern'] },
  model_policy: {
    mode: 'system-default' as const,
    thinkingLevel: 'medium' as const,
  },
  prompt_template: '命理模板',
  skill_bundle_ids: ['bundle-bazi'],
  skill_ids: ['skill-bazi'],
  skill_snapshot_ids: ['snapshot-bazi'],
  sort_order: 20,
};

describe('startSimpleWorkflowForOwnedUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateChatSession.mockImplementation(
      async (session: {
        id: string;
        accountId: string;
        userId: string;
        title: string;
      }) => ({
        id: session.id,
        account_id: session.accountId,
        user_id: session.userId,
        title: session.title,
        created_at: '2026-06-09T00:00:00.000Z',
        updated_at: '2026-06-09T00:00:00.000Z',
        deleted_at: null,
      }),
    );
    mockStoreMessage.mockResolvedValue(undefined);
    mockTouchChatSession.mockResolvedValue(undefined);
    mockResolveSimpleWorkflowLlmRuntime.mockResolvedValue({
      model: 'gpt-test',
    });
    mockExecuteDirectPaipan.mockResolvedValue({
      skill: { dir: 'iching-paipan' },
      requestSummary: '六爻排盘',
      sessionTitle: '六爻排盘',
      skillContextEntry: {
        skill: 'iching-paipan',
        output: '六爻盘面',
        artifactType: 'skill.iching-paipan',
        artifactTitle: '六爻排盘',
        artifactData: { ok: true },
      },
    });
    mockSendOwnedChatSessionMessage.mockResolvedValue({
      ok: true,
      data: {
        text: '',
        accepted: true,
        request_id: 'req-1',
      },
    });
  });

  it('starts a divination workflow with liuyao defaults and selected board', async () => {
    mockGetDefaultSimpleWorkflowPreset.mockResolvedValue(divinationPreset);

    const result = await startSimpleWorkflowForOwnedUser('user-1', {
      kind: 'divination',
      question: '我该不该换工作？',
      background: '最近有新机会',
    });

    expect(result.ok).toBe(true);
    expect(mockGetDefaultSimpleWorkflowPreset).toHaveBeenCalledWith(
      'divination',
    );
    expect(mockExecuteDirectPaipan).toHaveBeenCalledWith({
      accountId: 'web:user-1',
      userId: 'user-1',
      skillDir: 'iching-paipan',
      input: { method: 'dayan' },
    });
    expect(mockSendOwnedChatSessionMessage).toHaveBeenCalledWith(
      'user-1',
      expect.stringMatching(/^session-/),
      expect.objectContaining({
        content: '我该不该换工作？',
        inputKind: 'normal',
        selectedBoardMessageId: expect.stringMatching(
          /^simple-workflow-board-/,
        ),
      }),
      expect.objectContaining({
        authorizedSkillBundleIds: undefined,
        authorizedWorkflowSkillIds: ['snapshot-liuyao'],
        llmRuntimeOverride: { model: 'gpt-test' },
        professionalAiQuotaBypass: 'simple_workflow_first_turn',
        runtimeUserMessageOverride: [
          '我该不该换工作？',
          '',
          '最近有新机会',
        ].join('\n'),
      }),
    );
    expect(
      mockSendOwnedChatSessionMessage.mock.calls[0]?.[3]
        ?.runtimeUserMessageOverride,
    ).not.toContain('占卜模板');
    expect(
      mockSendOwnedChatSessionMessage.mock.calls[0]?.[3]
        ?.runtimeUserMessageOverride,
    ).not.toContain('六爻盘面作答');
  });

  it('returns the created session before the first AI turn finishes enqueue preparation', async () => {
    mockGetDefaultSimpleWorkflowPreset.mockResolvedValue(divinationPreset);
    let resolveRuntime: ((runtime: { model: string }) => void) | undefined;
    mockResolveSimpleWorkflowLlmRuntime.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRuntime = resolve;
      }),
    );

    const result = await startSimpleWorkflowForOwnedUser('user-1', {
      kind: 'divination',
      question: '我该不该换工作？',
    });

    expect(result.ok).toBe(true);
    expect(mockSendOwnedChatSessionMessage).not.toHaveBeenCalled();

    resolveRuntime?.({ model: 'gpt-test' });
    await vi.waitFor(() => {
      expect(mockSendOwnedChatSessionMessage).toHaveBeenCalledWith(
        'user-1',
        expect.stringMatching(/^session-/),
        expect.objectContaining({
          content: '我该不该换工作？',
        }),
        expect.objectContaining({
          llmRuntimeOverride: { model: 'gpt-test' },
        }),
      );
    });
  });

  it('starts a natal workflow with bazi birth fields', async () => {
    mockGetDefaultSimpleWorkflowPreset.mockResolvedValue(natalPreset);
    mockExecuteDirectPaipan.mockResolvedValue({
      skill: { dir: 'bazi-paipan' },
      requestSummary: '八字排盘',
      sessionTitle: '八字排盘',
      skillContextEntry: {
        skill: 'bazi-paipan',
        output: '八字盘面',
        artifactType: 'skill.bazi-paipan',
        artifactTitle: '八字排盘',
      },
    });

    const result = await startSimpleWorkflowForOwnedUser('user-1', {
      kind: 'natal',
      solarDate: '1990-01-02',
      hour: 8,
      minute: 30,
      gender: '男',
      questionDirection: '事业方向',
    });

    expect(result.ok).toBe(true);
    expect(mockGetDefaultSimpleWorkflowPreset).toHaveBeenCalledWith('natal');
    expect(mockExecuteDirectPaipan).toHaveBeenCalledWith({
      accountId: 'web:user-1',
      userId: 'user-1',
      skillDir: 'bazi-paipan',
      input: {
        include: ['bazi', 'fortune', 'pattern'],
        solarDate: '1990-01-02',
        hour: 8,
        minute: 30,
        gender: '男',
      },
    });
    expect(mockSendOwnedChatSessionMessage).toHaveBeenCalledWith(
      'user-1',
      expect.any(String),
      expect.objectContaining({
        content: '命理分析：事业方向',
      }),
      expect.objectContaining({
        authorizedSkillBundleIds: undefined,
        authorizedWorkflowSkillIds: ['snapshot-bazi'],
        runtimeUserMessageOverride: '事业方向',
      }),
    );
    expect(
      mockSendOwnedChatSessionMessage.mock.calls[0]?.[3]
        ?.runtimeUserMessageOverride,
    ).not.toContain('命理模板');
    expect(
      mockSendOwnedChatSessionMessage.mock.calls[0]?.[3]
        ?.runtimeUserMessageOverride,
    ).not.toContain('八字盘面作答');
  });

  it('rejects an empty divination question before paipan', async () => {
    mockGetDefaultSimpleWorkflowPreset.mockResolvedValue(divinationPreset);

    const result = await startSimpleWorkflowForOwnedUser('user-1', {
      kind: 'divination',
      question: '   ',
    });

    expect(result.ok).toBe(false);
    expect(mockExecuteDirectPaipan).not.toHaveBeenCalled();
  });

  it('falls back to workflow bundle ids before a preset has saved snapshots', async () => {
    mockGetDefaultSimpleWorkflowPreset.mockResolvedValue({
      ...divinationPreset,
      skill_snapshot_ids: [],
    });

    const result = await startSimpleWorkflowForOwnedUser('user-1', {
      kind: 'divination',
      question: '我该不该换工作？',
    });

    expect(result.ok).toBe(true);
    await vi.waitFor(() => {
      expect(mockSendOwnedChatSessionMessage).toHaveBeenCalledWith(
        'user-1',
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({
          authorizedSkillBundleIds: ['bundle-liuyao'],
          authorizedWorkflowSkillIds: [],
        }),
      );
    });
  });
});
