import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createSyntheticSourceInfo, type Skill } from '@earendil-works/pi-coding-agent';

import { createRequestScope } from '../request-scope.js';
import { createPiCustomTools } from './tools.js';

const DEFAULT_PI_TOOL_NAMES = [
  'get_current_time',
  'get_ganzhi_by_datetime',
  'reverse_ganzhi',
];

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
  it('exposes deterministic time tools when no readable skills are present', () => {
    const tools = createPiCustomTools({
      requestScope: createRequestScope(),
      recordExecution: vi.fn(),
    });

    expect(tools.map((tool) => tool.name)).toEqual(DEFAULT_PI_TOOL_NAMES);
  });

  it('returns current time in the requested timezone', async () => {
    const recordExecution = vi.fn();
    const tools = createPiCustomTools({
      requestScope: createRequestScope(),
      recordExecution,
      now: () => new Date('2026-04-25T06:00:00.000Z'),
    });
    const timeTool = tools.find((tool) => tool.name === 'get_current_time')!;

    const result = await timeTool.execute(
      'time-1',
      { timezone: 'Asia/Shanghai' },
      undefined,
      undefined,
      undefined as never,
    );

    expect(result.details).toMatchObject({
      isError: false,
      timezone: 'Asia/Shanghai',
      iso: '2026-04-25T06:00:00.000Z',
      unixMs: 1777096800000,
      local: '2026-04-25 14:00:00',
    });
    expect(recordExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        invocation: expect.objectContaining({ toolName: 'get_current_time' }),
        isError: false,
      }),
    );
  });

  it('calculates ganzhi pillars for a Gregorian datetime', async () => {
    const tools = createPiCustomTools({
      requestScope: createRequestScope(),
      recordExecution: vi.fn(),
    });
    const ganzhiTool = tools.find(
      (tool) => tool.name === 'get_ganzhi_by_datetime',
    )!;

    const result = await ganzhiTool.execute(
      'ganzhi-1',
      { year: 2026, month: 4, day: 25, hour: 14 },
      undefined,
      undefined,
      undefined as never,
    );

    expect(result.details).toMatchObject({
      isError: false,
      solar: '2026年4月25日 14:00:00',
      lunar: '农历丙午年三月初九辛未时',
      ganzhi: {
        year: '丙午',
        month: '壬辰',
        day: '己巳',
        hour: '辛未',
        eightChar: '丙午 壬辰 己巳 辛未',
      },
    });
  });

  it('reverses four-pillar ganzhi to matching Gregorian datetimes', async () => {
    const tools = createPiCustomTools({
      requestScope: createRequestScope(),
      recordExecution: vi.fn(),
    });
    const reverseTool = tools.find((tool) => tool.name === 'reverse_ganzhi')!;

    const result = await reverseTool.execute(
      'reverse-1',
      {
        year: '丙午',
        month: '壬辰',
        day: '己巳',
        hour: '辛未',
        startYear: 2026,
        endYear: 2026,
      },
      undefined,
      undefined,
      undefined as never,
    );

    expect(result.details).toMatchObject({
      isError: false,
      mode: 'eight_char',
      total: 1,
      truncated: false,
      matches: [
        {
          solar: '2026年4月25日 14:00:00',
          year: 2026,
          month: 4,
          day: 25,
          hour: 14,
        },
      ],
    });
  });

  it('adds a scoped read tool for visible request skill resources only', async () => {
    const readableSkill = createReadableSkillFixture();
    const recordExecution = vi.fn();
    const tools = createPiCustomTools({
      requestScope: createRequestScope(),
      readableSkills: [readableSkill],
      recordExecution,
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      ...DEFAULT_PI_TOOL_NAMES,
      'read',
    ]);

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

  it('supports Pi-style offset continuation for large skill files', async () => {
    const readableSkill = createReadableSkillFixture();
    fs.writeFileSync(
      readableSkill.filePath,
      ['line 1', 'line 2', 'line 3', 'line 4'].join('\n'),
    );
    const tools = createPiCustomTools({
      requestScope: createRequestScope(),
      readableSkills: [readableSkill],
      recordExecution: vi.fn(),
    });
    const readTool = tools.find((tool) => tool.name === 'read')!;

    const firstPage = await readTool.execute(
      'read-page-1',
      { path: readableSkill.filePath, limit: 2 },
      undefined,
      undefined,
      undefined as never,
    );
    const secondPage = await readTool.execute(
      'read-page-2',
      { path: readableSkill.filePath, offset: 3, limit: 2 },
      undefined,
      undefined,
      undefined as never,
    );
    const outOfRange = await readTool.execute(
      'read-page-3',
      { path: readableSkill.filePath, offset: 99 },
      undefined,
      undefined,
      undefined as never,
    );

    expect(firstPage.content[0]).toEqual({
      type: 'text',
      text: [
        'line 1',
        'line 2',
        '',
        '[Showing lines 1-2 of 4. Use offset=3 to continue.]',
      ].join('\n'),
    });
    expect(firstPage.details).toMatchObject({
      isError: false,
      offset: 1,
      limit: 2,
      totalLines: 4,
      nextOffset: 3,
    });
    expect(secondPage.content[0]).toEqual({
      type: 'text',
      text: ['line 3', 'line 4'].join('\n'),
    });
    expect(secondPage.details).toMatchObject({
      isError: false,
      offset: 3,
      limit: 2,
      totalLines: 4,
    });
    expect(outOfRange.details).toMatchObject({
      isError: true,
      output: expect.stringContaining('offset=99 超出文件末尾'),
    });
  });

  it('reads any markdown file inside a visible skill bundle by relative path', async () => {
    const readableSkill = createReadableSkillFixture();
    const docsDir = path.join(readableSkill.baseDir, 'docs');
    fs.mkdirSync(docsDir);
    fs.writeFileSync(path.join(docsDir, 'knowledge.md'), '知识正文');
    fs.writeFileSync(path.join(readableSkill.baseDir, 'secret.txt'), '非 Markdown');
    const tools = createPiCustomTools({
      requestScope: createRequestScope(),
      readableSkills: [readableSkill],
      recordExecution: vi.fn(),
    });
    const readTool = tools.find((tool) => tool.name === 'read')!;

    const markdown = await readTool.execute(
      'read-md',
      { path: 'docs/knowledge.md' },
      undefined,
      undefined,
      undefined as never,
    );
    const nonMarkdown = await readTool.execute(
      'read-txt',
      { path: 'secret.txt' },
      undefined,
      undefined,
      undefined as never,
    );
    const outside = await readTool.execute(
      'read-outside',
      { path: '../outside.md' },
      undefined,
      undefined,
      undefined as never,
    );

    expect(markdown.content[0]).toEqual({
      type: 'text',
      text: '知识正文',
    });
    expect(markdown.details).toMatchObject({
      isError: false,
      path: path.join(docsDir, 'knowledge.md'),
    });
    expect(nonMarkdown.details).toMatchObject({
      isError: true,
      output: expect.stringContaining('不是授权 Skill 内的 Markdown 文件'),
    });
    expect(outside.details).toMatchObject({
      isError: true,
      output: expect.stringContaining('不属于本轮可见 Skill 目录'),
    });
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
