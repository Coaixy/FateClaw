import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createSyntheticSourceInfo, type Skill } from '@earendil-works/pi-coding-agent';

import { createRequestScope } from '../request-scope.js';
import { createPiCustomTools } from './tools.js';

function createReadableSkillFixture(): Skill {
  const skillDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'fateclaw-readable-skill-'),
  );
  const skillFile = path.join(skillDir, 'SKILL.md');
  fs.writeFileSync(
    skillFile,
    [
      '---',
      'name: private-bazi',
      'description: 私有八字知识',
      '---',
      '',
      '# 私有八字知识',
      '',
      '调用 Pi read 读取 Markdown 知识。',
    ].join('\n'),
  );
  return {
    name: 'private-bazi',
    description: '私有八字知识',
    filePath: skillFile,
    baseDir: skillDir,
    sourceInfo: createSyntheticSourceInfo(skillFile, {
      source: 'fateclaw-request-knowledge',
      baseDir: skillDir,
    }),
    disableModelInvocation: false,
  };
}

describe('createPiCustomTools', () => {
  it('exposes no custom tools when no readable skills are present', () => {
    const tools = createPiCustomTools({
      requestScope: createRequestScope(),
      recordExecution: vi.fn(),
    });

    expect(tools.map((tool) => tool.name)).toEqual([]);
  });

  it('adds a scoped read tool for visible request skill resources only', async () => {
    const readableSkill = createReadableSkillFixture();
    const recordExecution = vi.fn();
    const tools = createPiCustomTools({
      requestScope: createRequestScope(),
      readableSkills: [readableSkill],
      recordExecution,
    });

    expect(tools.map((tool) => tool.name)).toEqual(['read']);

    const readTool = tools.find((tool) => tool.name === 'read')!;
    const ok = await readTool.execute(
      'read-1',
      { path: readableSkill.filePath },
      undefined,
      undefined,
      undefined as never,
    );
    const blocked = await readTool.execute(
      'read-2',
      { path: '/Users/example/.pi/skills/private/SKILL.md' },
      undefined,
      undefined,
      undefined as never,
    );
    const blockedDetails = blocked.details as {
      isError: boolean;
      output: string;
    };

    expect(ok.content[0]).toEqual({
      type: 'text',
      text: expect.stringContaining('调用 Pi read'),
    });
    expect(blockedDetails.isError).toBe(true);
    expect(blockedDetails.output).toContain('读取被拒绝');
    expect(recordExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        invocation: expect.objectContaining({ toolName: 'read' }),
        isError: false,
      }),
    );
    expect(recordExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        invocation: expect.objectContaining({ id: 'read-2' }),
        isError: true,
      }),
    );
  });

  it('does not expose FateClaw deterministic or legacy domain-specific tools as Pi custom tools', () => {
    const tools = createPiCustomTools({
      requestScope: createRequestScope(),
      recordExecution: vi.fn(),
    });

    const legacyToolNames = [
      'prepare_xuanxue_interpretation',
      'list_knowledge_sections',
      'read_knowledge_section',
    ];
    expect(tools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining([
        ...legacyToolNames,
        'bazi_paipan',
        'iching_paipan',
        'jingzhan_paipan',
        'qimen_paipan',
        'ziwei_paipan',
      ]),
    );
  });
});
