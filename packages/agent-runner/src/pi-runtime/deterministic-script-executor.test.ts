import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const { mockEnsureOfficialScriptDependenciesAccessible } = vi.hoisted(() => ({
  mockEnsureOfficialScriptDependenciesAccessible: vi.fn(),
}));

vi.mock('../official-script-deps.js', () => ({
  ensureOfficialScriptDependenciesAccessible:
    mockEnsureOfficialScriptDependenciesAccessible,
}));

import { createRequestScope } from '../request-scope.js';
import { initContext } from '../context.js';
import type { AgentRuntimeDeps } from '../deps.js';
import { executePiDeterministicScript } from './deterministic-script-executor.js';
import { PI_DETERMINISTIC_SCRIPT_TOOLS } from './deterministic-tool-catalog.js';

const baziSpec = PI_DETERMINISTIC_SCRIPT_TOOLS.find(
  (tool) => tool.skillName === 'bazi-paipan',
)!;

function createDeps(args: {
  enabledSkillNames: string[];
  execute?: AgentRuntimeDeps['skillExecutor']['execute'];
}): AgentRuntimeDeps {
  return {
    skillCatalog: {
      listEnabledSkillNames: vi.fn(async () => args.enabledSkillNames),
      listOfficialSkillMetadata: vi.fn(() => []),
      loadOfficialSkillContent: vi.fn(() => null),
      listEffectiveUserSkills: vi.fn(async () => []),
      toggleUserSkill: vi.fn(async () => undefined),
    },
    skillExecutor: {
      execute:
        args.execute ??
        vi.fn(async () => ({
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

describe('executePiDeterministicScript', () => {
  beforeAll(() => {
    process.env.HUSHBAY_ACCOUNT_ID = 'test-account';
    process.env.HUSHBAY_USER_ID = 'test-user';
    process.env.HUSHBAY_TIMEZONE = 'Asia/Shanghai';
    initContext();
  });

  beforeEach(() => {
    mockEnsureOfficialScriptDependenciesAccessible.mockReset();
  });

  it('checks request user enablement before executing deterministic board tools', async () => {
    const deps = createDeps({ enabledSkillNames: [] });
    const result = await executePiDeterministicScript({
      spec: baziSpec,
      params: {
        solarDate: '1990-01-01',
        hour: 8,
        gender: '男',
      },
      options: {
        requestScope: createRequestScope(),
        runtimeDeps: deps,
        userId: 'user-denied',
      },
    });

    expect(result.isError).toBe(true);
    expect(result.error?.code).toBe('SKILL.NOT_ENABLED');
    expect(deps.skillCatalog.listEnabledSkillNames).toHaveBeenCalledWith(
      'user-denied',
    );
    expect(deps.skillExecutor.execute).not.toHaveBeenCalled();
  });

  it('executes the catalog script with validated stdin and default values', async () => {
    const skillsDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'pi-deterministic-script-test-'),
    );
    fs.mkdirSync(path.join(skillsDir, 'bazi-paipan'), { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, 'bazi-paipan', 'paipan.js'),
      '',
      'utf8',
    );
    const execute = vi.fn(async () => ({
      stdout: '{"ok":true}',
      stderr: '',
    }));
    const deps = createDeps({
      enabledSkillNames: ['八字排盘'],
      execute,
    });
    const scope = createRequestScope();
    const result = await executePiDeterministicScript({
      spec: baziSpec,
      params: {
        solarDate: '1990-01-01',
        hour: 8,
        gender: '男',
      },
      options: {
        requestScope: scope,
        runtimeDeps: deps,
        skillsDirOverride: skillsDir,
        userId: 'user-allowed',
        loopRunId: 'pi-request-1',
      },
    });

    expect(result).toEqual({ output: '{"ok":true}' });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        scriptPath: expect.stringContaining('bazi-paipan/paipan.js'),
        cwd: expect.stringContaining('bazi-paipan'),
        stdin: JSON.stringify({
          solarDate: '1990-01-01',
          hour: 8,
          gender: '男',
          minute: 0,
          zishiMode: 'early',
          childLimitMode: 'default',
        }),
      }),
    );
    expect(mockEnsureOfficialScriptDependenciesAccessible).toHaveBeenCalled();
  });
});
