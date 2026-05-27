import { beforeAll, describe, expect, it, vi } from 'vitest';

import { appendArtifact } from '../artifact-store.js';
import { initContext } from '../context.js';
import type { AgentRuntimeDeps } from '../deps.js';
import { createRequestScope } from '../request-scope.js';
import type { LlmRuntimeSnapshot } from '../types.js';
import { executePiInterpretTool } from './interpret-executor.js';

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

function makeRuntimeDeps(): AgentRuntimeDeps {
  return {
    memoryStore: {
      read: vi.fn(async () => ''),
      write: vi.fn(async () => undefined),
    },
    skillCatalog: {
      listOfficialSkillMetadata: vi.fn(() => []),
      loadOfficialSkillContent: vi.fn(() => null),
      listEnabledSkillNames: vi.fn(async () => []),
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
      execute: vi.fn(async () => ({
        stdout: '',
        stderr: '',
        killed: false,
      })),
    },
  };
}

describe('executePiInterpretTool without legacy composite runtime', () => {
  beforeAll(() => {
    process.env.FATECLAW_ACCOUNT_ID = 'test-account';
    process.env.FATECLAW_USER_ID = 'test-user';
    process.env.FATECLAW_TIMEZONE = 'Asia/Shanghai';
    initContext();
  });

  it('does not require legacy composite readiness in the Pi path', async () => {
    const requestScope = createRequestScope();
    appendArtifact(requestScope, {
      id: 'artifact-board',
      type: 'skill.iching-paipan',
      title: 'Skill 结果: iching-paipan',
      producer: 'iching-paipan',
      category: '六爻',
      payload: {
        method: 'manual',
        question: '测试问题',
        benGua: {
          guaName: '既济',
          palace: '坎',
          yaoList: [],
        },
        zhiGua: {
          guaName: '随',
          palace: '震',
          yaoList: [],
        },
      },
      rawOutput: JSON.stringify({
        method: 'manual',
        question: '测试问题',
        benGua: { guaName: '既济', palace: '坎', yaoList: [] },
        zhiGua: { guaName: '随', palace: '震', yaoList: [] },
      }),
      createdAt: '2026-04-13T00:00:00.000Z',
    });

    const result = await executePiInterpretTool({
      invocation: {
        id: 'call-interpret',
        toolName: 'interpret_xuanxue',
        args: {
          category: '六爻',
          question: '看事业',
          content_source: 'skill',
        },
        source: 'model',
      },
      options: {
        requestScope,
        runtimeDeps: makeRuntimeDeps(),
        llmRuntime,
        provider: 'pi-sdk',
        model: llmRuntime.model,
        loopRunId: 'pi-request',
      },
    });

    expect(result.result.isError).toBeFalsy();
    expect(result.skillContextEntry?.skill).toBe('xuanxue-jiedu');
    expect(result.result.output).toContain('current_request_artifact');
    expect(result.result.output).toContain('既济');
    expect(requestScope.traceEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool_call',
          toolName: 'interpret_xuanxue',
          piDirectExecutor: true,
        }),
        expect.objectContaining({
          type: 'interpret_xuanxue_prompt_prepared',
          boardSource: 'current_request_artifact',
        }),
      ]),
    );
  });
});
