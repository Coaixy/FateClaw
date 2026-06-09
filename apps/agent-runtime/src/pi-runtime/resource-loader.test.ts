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

function createTextSkillBundleFixture(dirName = 'private-bazi'): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'fateclaw-private-skill-'),
  );
  const skillDir = path.join(root, dirName);
  fs.mkdirSync(path.join(skillDir, 'docs'), { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      `name: ${dirName}`,
      `description: ${dirName} 入口`,
      '---',
      '',
      `# ${dirName} 知识`,
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
    soulStore: {
      read: vi.fn(),
      canEdit: vi.fn(async () => true),
      update: vi.fn(),
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
    expect(
      before.find((skill) => skill.name === 'private-bazi')?.filePath,
    ).toBe(
      path.join(
        before.find((skill) => skill.name === 'private-bazi')!.baseDir,
        'SKILL.md',
      ),
    );
    expect(loader.getAppendSystemPrompt().join('\n')).toContain('private-bazi');
    expect(loader.getSystemPrompt()).toContain(
      '不要调用或假设存在专用解读工具/解读 Skill',
    );
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

  it('passes authorized skill bundle ids into request-scoped private knowledge loading', async () => {
    const baziSkill: EffectiveUserSkill = {
      id: 'private-bazi-id',
      dir: 'private-bazi',
      name: '私有八字知识',
      description: '私有八字入口',
      bundle_uri: createTextSkillBundleFixture('private-bazi'),
      checksum: null,
      install_status: 'installed',
      visibility: 'private',
      source: 'self',
      source_bundle_ids: ['bundle-bazi'],
    };
    const liuyaoSkill: EffectiveUserSkill = {
      id: 'private-liuyao-id',
      dir: 'private-liuyao',
      name: '私有六爻知识',
      description: '私有六爻入口',
      bundle_uri: createTextSkillBundleFixture('private-liuyao'),
      checksum: null,
      install_status: 'installed',
      visibility: 'private',
      source: 'self',
      source_bundle_ids: ['bundle-liuyao'],
    };
    const listEffectiveUserSkills = vi.fn(async () => [
      baziSkill,
      liuyaoSkill,
    ]);
    const listWorkflowBundleSkills = vi.fn(async (bundleIds: string[]) =>
      [baziSkill, liuyaoSkill].filter((skill) =>
        skill.source_bundle_ids?.some((bundleId) =>
          bundleIds.includes(bundleId),
        ),
      ),
    );
    const deps: AgentRuntimeDeps = {
      soulStore: {
        read: vi.fn(),
        canEdit: vi.fn(async () => true),
        update: vi.fn(),
      },
      skillCatalog: {
        listEffectiveUserSkills,
        listWorkflowBundleSkills,
      },
    };

    const loader = await createPiResourceLoader({
      deps,
      userId: 'user-1',
      requestScope: createRequestScope(),
      containerInput: {
        ...containerInput,
        authorizedSkillBundleIds: ['bundle-bazi'],
      },
    });

    expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual([
      'private-bazi',
    ]);
    expect(listWorkflowBundleSkills).toHaveBeenCalledWith(['bundle-bazi']);
    expect(listEffectiveUserSkills).not.toHaveBeenCalled();
    expect(loader.getAppendSystemPrompt().join('\n')).toContain(
      '本轮 workflow/请求已授权的 Markdown Skill 知识库入口如下。',
    );
  });

  it('does not fall back to user skills when an explicit empty workflow bundle scope is provided', async () => {
    const deps = createDeps();
    const loader = await createPiResourceLoader({
      deps,
      userId: 'user-1',
      requestScope: createRequestScope(),
      containerInput: {
        ...containerInput,
        authorizedSkillBundleIds: [],
      },
    });

    expect(loader.getSkills().skills).toEqual([]);
    expect(deps.skillCatalog.listEffectiveUserSkills).not.toHaveBeenCalled();
    expect(loader.getAppendSystemPrompt().join('\n')).not.toContain(
      'private-bazi',
    );
  });
});
