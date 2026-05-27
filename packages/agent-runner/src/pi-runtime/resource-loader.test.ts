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
  provider: 'openai-compatible',
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

function createOfficialSkillFixture(): string {
  const skillsDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'fateclaw-pi-skills-'),
  );
  const baziDir = path.join(skillsDir, 'bazi-paipan');
  fs.mkdirSync(baziDir, { recursive: true });
  fs.writeFileSync(
    path.join(baziDir, 'legacy-manifest.json'),
    JSON.stringify(
      {
        name: '旧八字 manifest 名称',
        description: 'Pi runtime 不应读取旧 JSON manifest',
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(baziDir, 'SKILL.md'),
    [
      '---',
      'name: bazi-paipan',
      'description: 八字排盘',
      '---',
      '',
      '# 八字排盘',
      '',
      '调用 bazi_paipan 完成排盘。',
    ].join('\n'),
  );
  return skillsDir;
}

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
    trigger: '八字知识',
    bundle_uri: bundleUri,
    checksum: null,
    install_status: 'installed',
    visibility: 'private',
    source: 'self',
    category: '八字',
    category_normalized: 'bazi',
    match_keywords: [],
    match_patterns: [],
    example_queries: [],
    priority: 0,
    usage_mode: 'reference_only',
  };
  return {
    memoryStore: {
      read: vi.fn(),
      write: vi.fn(),
    },
    skillCatalog: {
      listOfficialSkillMetadata: vi.fn(() => {
        throw new Error('Pi resource loader 不应读取旧 JSON metadata');
      }),
      loadOfficialSkillContent: vi.fn(() => null),
      listEnabledSkillNames: vi.fn(async () => ['八字排盘']),
      listEffectiveUserSkills: vi.fn(async () => [privateSkill]),
      readTextSkillBundle: vi.fn(async () => ''),
      toggleUserSkill: vi.fn(),
    },
    taskStore: {
      list: vi.fn(),
    },
    messageBus: {
      pushOutbox: vi.fn(),
      pushTask: vi.fn(),
    },
    historyStore: {
      listRecent: vi.fn(),
    },
    skillExecutor: {
      execute: vi.fn(),
    },
  };
}

describe('createPiResourceLoader', () => {
  it('exposes only request-scoped skill metadata and keeps private content out of Pi skill files', async () => {
    const skillsDir = createOfficialSkillFixture();
    const deps = createDeps();
    const loader = await createPiResourceLoader({
      deps,
      userId: 'user-1',
      requestScope: createRequestScope(),
      containerInput,
      skillsDir,
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
    expect(before.map((skill) => skill.name)).toEqual([
      'bazi-paipan',
      'private-bazi',
    ]);
    expect(before.find((skill) => skill.name === 'bazi-paipan')?.filePath).toBe(
      path.join(skillsDir, 'bazi-paipan', 'SKILL.md'),
    );
    expect(before.find((skill) => skill.name === 'bazi-paipan')?.baseDir).toBe(
      path.join(skillsDir, 'bazi-paipan'),
    );
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
    expect(JSON.stringify(before)).not.toContain(
      '不能暴露到 Skill metadata 的私有正文',
    );
    expect(loader.getAppendSystemPrompt().join('\n')).not.toContain(
      '不能暴露到 Skill metadata 的私有正文',
    );
    expect(before.every((skill) => !skill.filePath.includes('.pi/skills'))).toBe(
      true,
    );
    expect(before.every((skill) => !skill.filePath.includes('.pi/agent'))).toBe(
      true,
    );
    expect(deps.skillCatalog.listEffectiveUserSkills).toHaveBeenCalledWith(
      'user-1',
    );
    expect(deps.skillCatalog.listOfficialSkillMetadata).not.toHaveBeenCalled();
  });
});
