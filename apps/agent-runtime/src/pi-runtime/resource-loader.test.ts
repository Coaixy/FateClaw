import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { createRequestScope } from '../request-scope.js';
import type { AgentRuntimeDeps } from '../deps.js';
import type { EffectiveUserSkill } from '../agent-db.js';
import type { ContainerInput, LlmRuntimeSnapshot } from '../types.js';
import { createPiResourceLoader } from './resource-loader.js';

const llmRuntime: LlmRuntimeSnapshot = {
  source: 'custom',
  billingMode: 'none',
  modelConfigId: 'user-1',
  piApi: 'openai-completions',
  model: 'gpt-4o',
  apiKey: 'test-key',
  authMode: 'openai_api_key',
  providerKey: 'main-openai',
};

const containerInput: ContainerInput = {
  accountId: 'web:user-1',
  sessionId: 'session-1',
  llmRuntime,
  userMessage: '看一下',
  history: [],
};

function createTextSkillBundleFixture(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'fateclaw-private-skill-'),
  );
  const skillDir = path.join(root, 'private-bazi');
  fs.mkdirSync(path.join(skillDir, 'docs'), { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: private-bazi',
      'description: 私有八字入口',
      '---',
      '',
      '# 私有八字知识',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(skillDir, 'docs', '格局.md'),
    '不能暴露到 Skill metadata 的私有正文',
  );
  return skillDir;
}

function createDeps(): AgentRuntimeDeps {
  const bundleUri = createTextSkillBundleFixture();
  const privateSkill: EffectiveUserSkill = {
    id: 'private-bazi-id',
    dir: 'private-bazi',
    name: '私有八字知识',
    description: '私有八字入口',
    bundle_uri: bundleUri,
    checksum: null,
    install_status: 'installed',
    visibility: 'private',
    source: 'self',
  };
  return {
    memoryStore: {
      read: vi.fn(),
    },
    skillCatalog: {
      listEffectiveUserSkills: vi.fn(async () => [privateSkill]),
    },
  };
}

describe('createPiResourceLoader', () => {
  it('exposes only request-scoped skill metadata and keeps private content out of Pi skill files', async () => {
    const deps = createDeps();
    const loader = await createPiResourceLoader({
      deps,
      userId: 'user-1',
      requestScope: createRequestScope(),
      containerInput,
    });

    const before = loader.getSkills().skills;
    loader.extendResources({
      skillPaths: [
        {
          path: '/Users/example/.pi/skills/leaked-private-skill',
          metadata: {
            source: 'test',
            scope: 'temporary',
            origin: 'top-level',
          },
        },
      ],
    });
    const after = loader.getSkills().skills;

    expect(after).toEqual(before);
    expect(before.map((skill) => skill.name)).toEqual(['private-bazi']);
    expect(
      before.find((skill) => skill.name === 'private-bazi')
        ?.disableModelInvocation,
    ).toBe(false);
    expect(before.find((skill) => skill.name === 'private-bazi')?.filePath).toBe(
      path.join(
        before.find((skill) => skill.name === 'private-bazi')!.baseDir,
        'SKILL.md',
      ),
    );
    expect(loader.getAppendSystemPrompt().join('\n')).toContain(
      'private-bazi',
    );
    expect(loader.getSystemPrompt()).toContain('不要调用或假设存在专用解读工具/解读 Skill');
    expect(JSON.stringify(before)).not.toContain(
      '不能暴露到 Skill metadata 的私有正文',
    );
    expect(loader.getAppendSystemPrompt().join('\n')).not.toContain(
      '不能暴露到 Skill metadata 的私有正文',
    );
    const privateSkills = before.filter(
      (skill) => skill.sourceInfo.source === 'fateclaw-request-knowledge',
    );
    expect(
      privateSkills.every((skill) => !skill.filePath.includes('.pi/skills')),
    ).toBe(true);
    expect(
      privateSkills.every((skill) => !skill.filePath.includes('.pi/agent')),
    ).toBe(true);
    expect(deps.skillCatalog.listEffectiveUserSkills).toHaveBeenCalledWith(
      'user-1',
    );
  });
});
