import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { createRequestScope } from '../../src/request-scope.js';
import type { AgentRuntimeDeps } from '../../src/deps.js';
import type { EffectiveUserSkill } from '../../src/agent-db.js';
import type { ContainerInput, LlmRuntimeSnapshot } from '../../src/types.js';
import { createPiResourceLoader } from '../../src/pi-runtime/resource-loader.js';
import { prepareSkillContent } from '@fateclaw/contracts/skills/content';
import { SkillContentCache } from '../../src/skill-content-cache.js';

const roots: string[] = [];
const originalTextSkillsDir = process.env.FATECLAW_TEXT_SKILLS_DIR;
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
  if (originalTextSkillsDir === undefined)
    delete process.env.FATECLAW_TEXT_SKILLS_DIR;
  else process.env.FATECLAW_TEXT_SKILLS_DIR = originalTextSkillsDir;
});

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
  roots.push(root);
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
  process.env.FATECLAW_TEXT_SKILLS_DIR = path.join(path.dirname(bundleUri), 'cache');
  const revision = {
    skillId: 'private-bazi-id',
    revisionId: 'private-bazi-revision',
    ...prepareSkillContent(
      ['SKILL.md', 'docs/格局.md'].map((file) => ({
        path: file,
        content: fs.readFileSync(path.join(bundleUri, file), 'utf8'),
      })),
    ),
  };
  const privateSkill: EffectiveUserSkill = {
    id: 'private-bazi-id',
    dir: 'private-bazi',
    name: '私有八字知识',
    description: '私有八字入口',
    bundle_uri: bundleUri,
    checksum: revision.checksum,
    revision_id: revision.revisionId,
    format_version: revision.formatVersion,
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
    skillRevisions: { readRevision: vi.fn(async () => revision) },
    skillCatalog: {
      listEffectiveUserSkills: vi.fn(async () => [privateSkill]),
    },
  };
}

describe('createPiResourceLoader', () => {
  it('releases acquired snapshots if a later loader initialization step fails', async () => {
    const release = vi.fn();
    const deps = createDeps();
    vi.spyOn(SkillContentCache.prototype, 'acquire').mockResolvedValue({
      baseDir: '/synthetic/skill',
      filePath: '/synthetic/skill/SKILL.md',
      release,
    });
    await expect(
      createPiResourceLoader({
        deps,
        userId: 'user-1',
        requestScope: createRequestScope(),
        containerInput: {
          ...containerInput,
          personaPrompt: 1 as unknown as string,
        },
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(release).toHaveBeenCalledOnce();
  });
  it.each([undefined, '## Legacy delivery template'])(
    'does not impose a delivery outline, including for legacy requests (%s)',
    async (legacyTemplate) => {
      const input = { ...containerInput, guashiScriptTemplate: legacyTemplate };
      const loader = await createPiResourceLoader({
        deps: createDeps(),
        userId: 'user-1',
        requestScope: createRequestScope(),
        containerInput: input,
      });

      const prompt = loader.getSystemPrompt();
      expect(prompt).toContain(
        '完成用户请求后，直接用 assistant 回复最终答复。',
      );
      expect(prompt).not.toContain('固定章节');
      expect(prompt).not.toContain('## 核心论断');
      expect(prompt).not.toContain('Legacy delivery template');
      expect(prompt).not.toContain('[仅卦师]');
    },
  );

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
      '可读取本轮授权的 Markdown Skill 作为方法和知识依据',
    );
    expect(JSON.stringify(before)).not.toContain(
      '不能暴露到 Skill metadata 的私有正文',
    );
    expect(loader.getAppendSystemPrompt().join('\n')).not.toContain(
      '不能暴露到 Skill metadata 的私有正文',
    );
    expect(loader.getAppendSystemPrompt().join('\n')).not.toContain(
      '# private-bazi 知识',
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

  it('loads no effective user skills when explicit skill scope is empty', async () => {
    const deps = createDeps();
    const loader = await createPiResourceLoader({
      deps,
      userId: 'user-1',
      requestScope: createRequestScope(),
      containerInput: {
        ...containerInput,
        authorizedSkillIds: [],
      },
    });

    expect(loader.getSkills().skills).toEqual([]);
    expect(deps.skillCatalog.listEffectiveUserSkills).not.toHaveBeenCalled();
    expect(loader.getAppendSystemPrompt().join('\n')).not.toContain(
      'private-bazi',
    );
  });

  it('downloads only request-authorized database skills and injects their local snapshots', async () => {
    const deps = createDeps();
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'fateclaw-db-skill-loader-'),
    );
    roots.push(root);
    process.env.FATECLAW_TEXT_SKILLS_DIR = root;
    const files = [
      { path: 'SKILL.md', content: '# Authorized database skill' },
      { path: 'docs/private.md', content: 'Authorized private content' },
    ];
    const bundle = {
      skillId: 'database-skill',
      revisionId: 'database-revision',
      ...prepareSkillContent(files),
    };
    const skill: EffectiveUserSkill = {
      id: 'database-skill',
      dir: 'database-skill',
      name: 'Database Skill',
      description: 'Knowledge',
      bundle_uri: 'db://skill-content-revisions/database-revision',
      checksum: bundle.checksum,
      revision_id: bundle.revisionId,
      format_version: bundle.formatVersion,
      install_status: 'installed',
      visibility: 'private',
      source: 'self',
    };
    deps.skillCatalog.listEffectiveUserSkillsByIds = vi.fn(async () => [skill]);
    deps.skillRevisions.readRevision = vi.fn(async () => bundle);
    const loader = await createPiResourceLoader({
      deps,
      userId: 'user-1',
      requestScope: createRequestScope(),
      containerInput: {
        ...containerInput,
        authorizedSkillIds: ['database-skill'],
      },
    });

    expect(deps.skillCatalog.listEffectiveUserSkillsByIds).toHaveBeenCalledWith(
      'user-1',
      ['database-skill'],
    );
    expect(deps.skillCatalog.listEffectiveUserSkills).not.toHaveBeenCalled();
    expect(deps.skillRevisions.readRevision).toHaveBeenCalledExactlyOnceWith(
      'database-skill',
      bundle.revisionId,
    );
    const loaded = loader.getSkills().skills;
    expect(loaded.map((skill) => skill.name)).toEqual(['database-skill']);
    expect(
      fs.readFileSync(path.join(loaded[0].baseDir, 'docs/private.md'), 'utf8'),
    ).toBe('Authorized private content');
    expect(loader.getAppendSystemPrompt().join('\n')).not.toContain(
      'Authorized private content',
    );
  });
});
