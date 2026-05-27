import { describe, expect, it, vi } from 'vitest';

const { mockExecutePiScriptSkillTool } = vi.hoisted(() => ({
  mockExecutePiScriptSkillTool: vi.fn(),
}));

vi.mock('./script-skill-executor.js', () => ({
  executePiScriptSkillTool: mockExecutePiScriptSkillTool,
}));

import { createRequestScope, setRequestId } from '../request-scope.js';
import type { AgentRuntimeDeps } from '../deps.js';
import { executePiPaipanRequest } from './paipan-request.js';

function createDeps(): AgentRuntimeDeps {
  return {
    skillCatalog: {
      listEnabledSkillNames: vi.fn(async () => ['八字排盘']),
      listOfficialSkillMetadata: vi.fn(() => []),
      loadOfficialSkillContent: vi.fn(() => null),
      listEffectiveUserSkills: vi.fn(async () => []),
      toggleUserSkill: vi.fn(async () => undefined),
    },
    skillExecutor: {
      execute: vi.fn(async () => ({
        stdout: '{"ok":true}',
        stderr: '',
      })),
    },
    memoryStore: {
      read: vi.fn(async () => ''),
      write: vi.fn(async () => undefined),
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
  };
}

describe('executePiPaipanRequest', () => {
  it('routes direct board requests through the Pi deterministic script tool', async () => {
    mockExecutePiScriptSkillTool.mockResolvedValue({
      result: { output: '{"ok":true}' },
      skillContextEntry: {
        skill: 'bazi-paipan',
        output: '{"ok":true}',
        artifactType: 'skill.bazi-paipan',
        artifactTitle: 'Skill 结果: bazi-paipan',
        artifactData: { ok: true },
      },
    });
    const requestScope = createRequestScope();
    setRequestId(requestScope, 'paipan-request-1');
    const deps = createDeps();

    const output = await executePiPaipanRequest({
      accountId: 'web:user-1',
      userId: 'user-1',
      skillDir: 'bazi-paipan',
      input: {
        solarDate: '1990-01-01',
        hour: 8,
        gender: '男',
      },
      displayTitle: '八字排盘',
      requestScope,
      deps,
    });

    expect(output.status).toBe('success');
    expect(output.result).toBe('已生成：八字排盘');
    expect(output.provider).toBe('pi-sdk');
    expect(output.model).toBe('pi-deterministic-paipan');
    expect(output.skillContext).toEqual([
      expect.objectContaining({
        skill: 'bazi-paipan',
        artifactTitle: '八字排盘',
      }),
    ]);
    expect(mockExecutePiScriptSkillTool).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: expect.objectContaining({
          toolName: 'bazi_paipan',
          skillName: 'bazi-paipan',
        }),
        params: expect.objectContaining({
          solarDate: '1990-01-01',
        }),
        options: expect.objectContaining({
          requestScope,
          runtimeDeps: deps,
          provider: 'pi-sdk',
          model: 'pi-deterministic-paipan',
          userId: 'user-1',
        }),
      }),
    );
    expect(output.traceEvents?.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'pi_paipan_request_start',
        'pi_paipan_request_completed',
      ]),
    );
  });
});
