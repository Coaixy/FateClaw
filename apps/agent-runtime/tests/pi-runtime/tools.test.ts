import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createSyntheticSourceInfo,
  type Skill,
} from '@earendil-works/pi-coding-agent';

import { createRequestScope } from '../../src/request-scope.js';
import type { SessionBoardContext } from '../../src/types.js';
import { createPiCustomTools } from '../../src/pi-runtime/tools.js';
import type { CreatePiToolsOptions } from '../../src/pi-runtime/tools.js';

const DEFAULT_PI_TOOL_NAMES = [
  'get_current_time',
  'get_ganzhi_by_datetime',
  'reverse_ganzhi',
  'read_soul',
  'edit_soul',
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

function createSessionBoardFixtures(): SessionBoardContext[] {
  return [
    {
      sourceMessageId: 'msg-board-1',
      source: 'official_paipan',
      skill: 'bazi-paipan',
      artifactTitle: '八字排盘',
      promptText: '当前选中八字盘面正文',
      artifactData: { bazi: '甲子 乙丑 丙寅 丁卯' },
      createdAt: '2026-04-25T06:00:00.000Z',
      isCurrent: true,
    },
    {
      sourceMessageId: 'msg-board-2',
      source: 'user_pasted_board',
      skill: 'user-pasted-board::八字',
      artifactTitle: '自贴盘面: 八字',
      promptText: '用户自贴盘面正文',
      artifactData: { category: '八字', content: '用户自贴盘面正文' },
      createdAt: '2026-04-26T06:00:00.000Z',
      isCurrent: false,
    },
  ];
}

function createTools(
  overrides: Partial<CreatePiToolsOptions> = {},
): ReturnType<typeof createPiCustomTools> {
  let soulContent = '用户 Soul：喜欢简洁结论。';
  const soulStore = overrides.soulStore ?? {
    read: vi.fn(async () => soulContent),
    canEdit: vi.fn(async () => true),
    update: vi.fn(async (_accountId: string, content: string) => {
      soulContent = content;
    }),
  };
  return createPiCustomTools({
    requestScope: createRequestScope(),
    accountId: 'web:user-1',
    soulStore,
    recordExecution: vi.fn(),
    ...overrides,
  });
}

describe('createPiCustomTools', () => {
  it('exposes deterministic time tools when no readable skills are present', () => {
    const tools = createTools();

    expect(tools.map((tool) => tool.name)).toEqual(DEFAULT_PI_TOOL_NAMES);
  });

  it('omits edit_soul when conversation Soul edits are disabled', () => {
    const tools = createTools({ soulEditEnabled: false });

    expect(tools.map((tool) => tool.name)).toEqual([
      'get_current_time',
      'get_ganzhi_by_datetime',
      'reverse_ganzhi',
      'read_soul',
    ]);
  });

  it('returns current time in the requested timezone', async () => {
    const recordExecution = vi.fn();
    const tools = createTools({
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

  it('can include current calendar and ganzhi details in current time', async () => {
    const tools = createTools({
      recordExecution: vi.fn(),
      now: () => new Date('2026-04-25T06:00:00.000Z'),
    });
    const timeTool = tools.find((tool) => tool.name === 'get_current_time')!;

    const result = await timeTool.execute(
      'time-calendar-1',
      { timezone: 'Asia/Shanghai', includeCalendar: true },
      undefined,
      undefined,
      undefined as never,
    );

    expect(result.details).toMatchObject({
      isError: false,
      local: '2026-04-25 14:00:00',
      includeCalendar: true,
      calendar: {
        solar: '2026年4月25日 14:00:00',
        lunar: '农历丙午年三月初九辛未时',
        ganzhi: {
          eightChar: '丙午 壬辰 己巳 辛未',
        },
      },
    });
  });

  it('calculates ganzhi pillars for a Gregorian datetime', async () => {
    const tools = createTools({
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
      calendar: {
        gregorian: {
          year: 2026,
          month: 4,
          day: 25,
          hour: 14,
        },
        lunarDate: {
          year: 2026,
          month: 3,
          day: 9,
          isLeapMonth: false,
        },
      },
      ganzhi: {
        year: '丙午',
        month: '壬辰',
        day: '己巳',
        hour: '辛未',
        eightChar: '丙午 壬辰 己巳 辛未',
      },
    });
  });

  it('converts a lunar datetime before calculating ganzhi pillars', async () => {
    const tools = createTools({
      recordExecution: vi.fn(),
    });
    const ganzhiTool = tools.find(
      (tool) => tool.name === 'get_ganzhi_by_datetime',
    )!;

    const result = await ganzhiTool.execute(
      'ganzhi-lunar-1',
      {
        inputCalendar: 'lunar',
        year: 2026,
        month: 3,
        day: 9,
        hour: 14,
      },
      undefined,
      undefined,
      undefined as never,
    );

    expect(result.details).toMatchObject({
      isError: false,
      input: {
        inputCalendar: 'lunar',
        isLeapMonth: false,
      },
      solar: '2026年4月25日 14:00:00',
      lunar: '农历丙午年三月初九辛未时',
      calendar: {
        gregorian: {
          year: 2026,
          month: 4,
          day: 25,
          hour: 14,
        },
      },
      ganzhi: {
        eightChar: '丙午 壬辰 己巳 辛未',
      },
    });
  });

  it('reverses four-pillar ganzhi to matching Gregorian datetimes', async () => {
    const tools = createTools({
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

  it('reads and edits the single Dashboard Soul with hash protection', async () => {
    let soulContent = '用户 Soul：喜欢简洁结论。';
    const soulStore = {
      read: vi.fn(async () => soulContent),
      canEdit: vi.fn(async () => true),
      update: vi.fn(async (_accountId: string, content: string) => {
        soulContent = content;
      }),
    };
    const tools = createTools({
      soulStore,
      userMessage: '帮我记住：以后叫我阿七，回答更直接。',
      recordExecution: vi.fn(),
    });
    const readSoul = tools.find((tool) => tool.name === 'read_soul')!;
    const editSoul = tools.find((tool) => tool.name === 'edit_soul')!;
    const newSoul = '用户 Soul：喜欢简洁结论。\n称呼用户为阿七。';

    const read = await readSoul.execute(
      'soul-read-1',
      {},
      undefined,
      undefined,
      undefined as never,
    );
    const baseHash = (read.details as { sha256: string }).sha256;
    const edit = await editSoul.execute(
      'soul-edit-1',
      {
        baseHash,
        newContent: newSoul,
        reason: '用户明确要求记住称呼和回答风格',
      },
      undefined,
      undefined,
      undefined as never,
    );

    expect(read.details).toMatchObject({
      isError: false,
      content: '用户 Soul：喜欢简洁结论。',
      charCount: '用户 Soul：喜欢简洁结论。'.length,
    });
    expect(edit.details).toMatchObject({
      isError: false,
      previousHash: baseHash,
      charCount: newSoul.length,
    });
    expect(soulStore.update).toHaveBeenCalledWith('web:user-1', newSoul);
  });

  it('rejects Soul edits without baseHash or with a stale hash', async () => {
    let soulContent = '用户 Soul：喜欢简洁结论。';
    const soulStore = {
      read: vi.fn(async () => soulContent),
      canEdit: vi.fn(async () => true),
      update: vi.fn(async (_accountId: string, content: string) => {
        soulContent = content;
      }),
    };
    const missingHashTools = createTools({
      soulStore,
      userMessage: '今天聊点别的',
      recordExecution: vi.fn(),
    });
    const missingHashEdit = missingHashTools.find(
      (tool) => tool.name === 'edit_soul',
    )!;

    const missingHash = await missingHashEdit.execute(
      'soul-edit-missing-hash',
      {
        baseHash: '',
        newContent: '随手覆盖',
        reason: '模型自行总结',
      },
      undefined,
      undefined,
      undefined as never,
    );

    const intentTools = createTools({
      soulStore,
      userMessage: '把我的记忆改一下',
      recordExecution: vi.fn(),
    });
    const staleEdit = intentTools.find((tool) => tool.name === 'edit_soul')!;
    const stale = await staleEdit.execute(
      'soul-edit-stale',
      {
        baseHash: 'stale',
        newContent: '新 Soul',
        reason: '用户要求修改记忆',
      },
      undefined,
      undefined,
      undefined as never,
    );

    expect(missingHash.details).toMatchObject({
      isError: true,
      error: expect.stringContaining('缺少 baseHash'),
    });
    expect(stale.details).toMatchObject({
      isError: true,
      error: expect.stringContaining('baseHash 与当前 Soul 不一致'),
    });
    expect(soulStore.update).not.toHaveBeenCalled();
  });

  it('adds a scoped read tool for visible request skill resources only', async () => {
    const readableSkill = createReadableSkillFixture();
    const recordExecution = vi.fn();
    const tools = createTools({
      readableSkills: [readableSkill],
      recordExecution,
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      ...DEFAULT_PI_TOOL_NAMES,
      'grep',
      'read',
    ]);

    const grepTool = tools.find((tool) => tool.name === 'grep')!;
    const readTool = tools.find((tool) => tool.name === 'read')!;
    const search = await grepTool.execute(
      'grep-1',
      { query: 'Markdown' },
      undefined,
      undefined,
      undefined as never,
    );
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

    expect(search.details).toMatchObject({
      isError: false,
      query: 'Markdown',
      total: 1,
      truncated: false,
      matches: [
        {
          path: readableSkill.filePath,
          relativePath: 'SKILL.md',
          skill: 'private-bazi',
          line: 8,
          text: '调用 Pi read 读取 Markdown 知识。',
        },
      ],
    });
    expect(ok.content[0]).toEqual({
      type: 'text',
      text: expect.stringContaining('调用 Pi read'),
    });
    expect(blockedDetails.isError).toBe(true);
    expect(blockedDetails.output).toContain('读取被拒绝');
    expect(recordExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        invocation: expect.objectContaining({ toolName: 'grep' }),
        isError: false,
      }),
    );
    expect(recordExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        invocation: expect.objectContaining({ id: 'read-1' }),
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

  it('greps only authorized markdown files inside visible skill bundles', async () => {
    const readableSkill = createReadableSkillFixture();
    const docsDir = path.join(readableSkill.baseDir, 'docs');
    fs.mkdirSync(docsDir);
    fs.writeFileSync(
      path.join(docsDir, 'knowledge.md'),
      ['Alpha beta', 'beta conclusion', 'BETA hidden'].join('\n'),
    );
    fs.writeFileSync(
      path.join(readableSkill.baseDir, 'secret.txt'),
      'beta secret',
    );
    const tools = createTools({
      readableSkills: [readableSkill],
      recordExecution: vi.fn(),
    });
    const grepTool = tools.find((tool) => tool.name === 'grep')!;

    const caseInsensitive = await grepTool.execute(
      'grep-md',
      { query: 'beta', path: 'docs', limit: 2 },
      undefined,
      undefined,
      undefined as never,
    );
    const caseSensitive = await grepTool.execute(
      'grep-case',
      { query: 'beta', path: 'docs/knowledge.md', caseSensitive: true },
      undefined,
      undefined,
      undefined as never,
    );
    const nonMarkdown = await grepTool.execute(
      'grep-txt',
      { query: 'beta', path: 'secret.txt' },
      undefined,
      undefined,
      undefined as never,
    );
    const outside = await grepTool.execute(
      'grep-outside',
      { query: 'beta', path: '../outside.md' },
      undefined,
      undefined,
      undefined as never,
    );

    expect(caseInsensitive.details).toMatchObject({
      isError: false,
      total: 3,
      totalIsExact: false,
      truncated: true,
      searchedFiles: 1,
      matches: [
        {
          relativePath: 'docs/knowledge.md',
          line: 1,
          text: 'Alpha beta',
        },
        {
          relativePath: 'docs/knowledge.md',
          line: 2,
          text: 'beta conclusion',
        },
      ],
    });
    expect(caseSensitive.details).toMatchObject({
      isError: false,
      total: 2,
      totalIsExact: true,
      truncated: false,
      matches: [
        {
          relativePath: 'docs/knowledge.md',
          line: 1,
          text: 'Alpha beta',
        },
        {
          relativePath: 'docs/knowledge.md',
          line: 2,
          text: 'beta conclusion',
        },
      ],
    });
    expect(nonMarkdown.details).toMatchObject({
      isError: true,
      output: expect.stringContaining(
        '不是授权 Skill 内的 Markdown 文件或目录',
      ),
      total: 0,
      matches: [],
    });
    expect(outside.details).toMatchObject({
      isError: true,
      output: expect.stringContaining('不属于本轮可见 Skill 目录'),
    });
  });

  it('greps a relative path that exists in only one visible skill bundle', async () => {
    const firstSkill = createReadableSkillFixture();
    const secondSkill = {
      ...createReadableSkillFixture(),
      name: 'second-bazi',
    };
    const docsDir = path.join(secondSkill.baseDir, 'docs');
    const knowledgePath = path.join(docsDir, 'knowledge.md');
    fs.mkdirSync(docsDir);
    fs.writeFileSync(knowledgePath, 'only second needle');
    const tools = createTools({
      readableSkills: [firstSkill, secondSkill],
      recordExecution: vi.fn(),
    });
    const grepTool = tools.find((tool) => tool.name === 'grep')!;

    const result = await grepTool.execute(
      'grep-relative-one-skill',
      { query: 'needle', path: 'docs/knowledge.md' },
      undefined,
      undefined,
      undefined as never,
    );

    // 相对文件路径只在 second-bazi 命中；命中文件后范围扩展到 second-bazi 整个目录
    //（SKILL.md + docs/knowledge.md 共 2 个文件），needle 只在 knowledge.md 出现。
    expect(result.details).toMatchObject({
      isError: false,
      total: 1,
      totalIsExact: true,
      searchedFiles: 2,
      expandedToSkillDir: true,
      matches: [
        {
          path: knowledgePath,
          relativePath: 'docs/knowledge.md',
          skill: 'second-bazi',
          line: 1,
          text: 'only second needle',
        },
      ],
    });
  });

  it('expands a file path to the whole skill directory so sibling docs are searched', async () => {
    const readableSkill = createReadableSkillFixture();
    const docsDir = path.join(readableSkill.baseDir, 'docs');
    fs.mkdirSync(docsDir);
    // 关键词只在兄弟文件 docs/ch1.md 里，SKILL.md 正文并不含它
    fs.writeFileSync(path.join(docsDir, 'ch1.md'), '甲木格局详解 needle');
    const tools = createTools({
      readableSkills: [readableSkill],
      recordExecution: vi.fn(),
    });
    const grepTool = tools.find((tool) => tool.name === 'grep')!;

    // 模型只知道 SKILL.md 的路径（<available_skills> 的 location），把它当搜索范围传入。
    // 旧行为只搜 SKILL.md → 0 命中；新行为扩展到整个 Skill 目录 → 命中 docs/ch1.md。
    const result = await grepTool.execute(
      'grep-expand-file',
      { query: 'needle', path: readableSkill.filePath },
      undefined,
      undefined,
      undefined as never,
    );

    expect(result.details).toMatchObject({
      isError: false,
      total: 1,
      expandedToSkillDir: true,
      matches: [
        {
          relativePath: 'docs/ch1.md',
          text: '甲木格局详解 needle',
        },
      ],
    });
    // 扩展行为对模型透明：output 里出现说明
    const expanded = result.details as { output: string };
    expect(expanded.output).toContain('扩展');
  });

  it('greps with regex by default and falls back to literal on invalid pattern', async () => {
    const readableSkill = createReadableSkillFixture();
    const docsDir = path.join(readableSkill.baseDir, 'docs');
    fs.mkdirSync(docsDir);
    fs.writeFileSync(
      path.join(docsDir, 'knowledge.md'),
      ['甲木生于寅月', '乙木见流年庚金', '丙火无关行', '括号示例 (甲)'].join('\n'),
    );
    const tools = createTools({
      readableSkills: [readableSkill],
      recordExecution: vi.fn(),
    });
    const grepTool = tools.find((tool) => tool.name === 'grep')!;

    // 默认按正则：[甲乙]木 命中「甲木」「乙木」两行
    const defaultRegex = await grepTool.execute(
      'grep-default-regex',
      { query: '[甲乙]木', path: 'docs/knowledge.md' },
      undefined,
      undefined,
      undefined as never,
    );
    // 强制字面：文件里没有「[甲乙]木」整串 → 0 命中
    const literal = await grepTool.execute(
      'grep-literal',
      { query: '[甲乙]木', regex: false, path: 'docs/knowledge.md' },
      undefined,
      undefined,
      undefined as never,
    );
    // 非法正则「(」→ 自动回退字面，命中含「(」的行
    const fallback = await grepTool.execute(
      'grep-fallback',
      { query: '(', path: 'docs/knowledge.md' },
      undefined,
      undefined,
      undefined as never,
    );

    // 默认正则命中两行，regex 标注为 true
    expect(defaultRegex.details).toMatchObject({
      isError: false,
      regex: true,
      total: 2,
    });
    // regex=false 强制字面，整串不存在 → 0
    expect(literal.details).toMatchObject({
      isError: false,
      regex: false,
      total: 0,
    });
    // 非法正则回退字面：不报错、regex 标注为 false、命中字面「(」一行
    expect(fallback.details).toMatchObject({
      isError: false,
      regex: false,
      total: 1,
    });
  });

  it('greps large markdown files beyond the legacy in-memory cap', async () => {
    const readableSkill = createReadableSkillFixture();
    const bigFile = path.join(readableSkill.baseDir, 'big.md');
    // 构造超过旧 256KB 上限的文件（约 320KB），命中行藏在末尾，验证不再被静默跳过
    const lines = Array.from({ length: 20_000 }, (_, i) => `填充行 ${i}`);
    lines.push('稀有关键词 needle 出现在末尾');
    fs.writeFileSync(bigFile, lines.join('\n'));
    const tools = createTools({
      readableSkills: [readableSkill],
      recordExecution: vi.fn(),
    });
    const grepTool = tools.find((tool) => tool.name === 'grep')!;

    const result = await grepTool.execute(
      'grep-large',
      { query: 'needle', path: 'big.md' },
      undefined,
      undefined,
      undefined as never,
    );

    expect(result.details).toMatchObject({
      isError: false,
      total: 1,
      matches: [
        {
          relativePath: 'big.md',
          text: '稀有关键词 needle 出现在末尾',
        },
      ],
    });
  });

  it('caches markdown file discovery for repeated grep calls in one tool instance', async () => {
    const readableSkill = createReadableSkillFixture();
    const docsDir = path.join(readableSkill.baseDir, 'docs');
    fs.mkdirSync(docsDir);
    fs.writeFileSync(path.join(docsDir, 'a.md'), 'alpha beta');
    const tools = createTools({
      readableSkills: [readableSkill],
      recordExecution: vi.fn(),
    });
    const grepTool = tools.find((tool) => tool.name === 'grep')!;

    const first = await grepTool.execute(
      'grep-cache-1',
      { query: 'alpha', path: 'docs' },
      undefined,
      undefined,
      undefined as never,
    );
    fs.writeFileSync(path.join(docsDir, 'b.md'), 'alpha late file');
    const second = await grepTool.execute(
      'grep-cache-2',
      { query: 'alpha', path: 'docs' },
      undefined,
      undefined,
      undefined as never,
    );

    expect(first.details).toMatchObject({
      isError: false,
      searchedFiles: 1,
      total: 1,
      totalIsExact: true,
    });
    expect(second.details).toMatchObject({
      isError: false,
      searchedFiles: 1,
      total: 1,
      totalIsExact: true,
      matches: [
        expect.objectContaining({
          relativePath: 'docs/a.md',
        }),
      ],
    });
  });

  it('adds one session board tool for listing and reading visible boards', async () => {
    const recordExecution = vi.fn();
    const tools = createTools({
      sessionBoards: createSessionBoardFixtures(),
      recordExecution,
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      ...DEFAULT_PI_TOOL_NAMES,
      'get_session_board',
    ]);

    const boardTool = tools.find((tool) => tool.name === 'get_session_board')!;
    const listResult = await boardTool.execute(
      'board-list',
      { mode: 'list' },
      undefined,
      undefined,
      undefined as never,
    );
    const detailResult = await boardTool.execute(
      'board-detail',
      { mode: 'detail', index: 2 },
      undefined,
      undefined,
      undefined as never,
    );
    const missingResult = await boardTool.execute(
      'board-missing',
      { mode: 'detail', sourceMessageId: 'missing' },
      undefined,
      undefined,
      undefined as never,
    );

    expect(listResult.details).toMatchObject({
      isError: false,
      mode: 'list',
      total: 2,
      boards: [
        {
          index: 1,
          sourceMessageId: 'msg-board-1',
          skill: 'bazi-paipan',
          isCurrent: true,
          preview: '当前选中八字盘面正文',
          hasArtifactData: true,
        },
        {
          index: 2,
          sourceMessageId: 'msg-board-2',
          skill: 'user-pasted-board::八字',
          isCurrent: false,
          preview: '用户自贴盘面正文',
          hasArtifactData: true,
        },
      ],
    });
    expect(detailResult.details).toMatchObject({
      isError: false,
      mode: 'detail',
      board: {
        index: 2,
        sourceMessageId: 'msg-board-2',
        promptText: '用户自贴盘面正文',
        artifactData: {
          category: '八字',
          content: '用户自贴盘面正文',
        },
      },
    });
    expect(missingResult.details).toMatchObject({
      isError: true,
      error: '未找到 sourceMessageId=missing 的盘面。',
    });
    expect(recordExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        invocation: expect.objectContaining({ toolName: 'get_session_board' }),
        isError: false,
      }),
    );
    expect(recordExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        invocation: expect.objectContaining({ id: 'board-missing' }),
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
    const tools = createTools({
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
    fs.writeFileSync(
      path.join(readableSkill.baseDir, 'secret.txt'),
      '非 Markdown',
    );
    const tools = createTools({
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

  it('reads the existing markdown when multiple skills share a relative path', async () => {
    const first = createReadableSkillFixture();
    const second: Skill = {
      ...createReadableSkillFixture(),
      name: 'second-bazi',
    };
    // 相对路径 docs/knowledge.md 只在「第二个」skill 真实存在
    const secondDocs = path.join(second.baseDir, 'docs');
    fs.mkdirSync(secondDocs);
    fs.writeFileSync(
      path.join(secondDocs, 'knowledge.md'),
      '只有第二个 skill 有的内容',
    );
    const tools = createTools({
      readableSkills: [first, second],
      recordExecution: vi.fn(),
    });
    const readTool = tools.find((tool) => tool.name === 'read')!;

    const result = await readTool.execute(
      'read-multi-skill',
      { path: 'docs/knowledge.md' },
      undefined,
      undefined,
      undefined as never,
    );

    // 修复前：相对路径被盲归到数组第一个 skill → ENOENT；
    // 修复后：解析阶段 stat 跳过不存在候选，命中第二个 skill 的真实文件
    expect(result.details).toMatchObject({
      isError: false,
      path: path.join(secondDocs, 'knowledge.md'),
    });
    expect(result.content[0]).toEqual({
      type: 'text',
      text: '只有第二个 skill 有的内容',
    });
  });

  it('flags ambiguity when the same relative path exists in multiple skills', async () => {
    const first: Skill = {
      ...createReadableSkillFixture(),
      name: 'first-bazi',
    };
    const second: Skill = {
      ...createReadableSkillFixture(),
      name: 'second-bazi',
    };
    // 两个 skill 都有 docs/knowledge.md，内容不同
    for (const [skill, body] of [
      [first, 'FIRST 的内容'],
      [second, 'SECOND 的内容'],
    ] as const) {
      const dir = path.join(skill.baseDir, 'docs');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'knowledge.md'), body);
    }
    const tools = createTools({
      readableSkills: [first, second],
      recordExecution: vi.fn(),
    });
    const readTool = tools.find((tool) => tool.name === 'read')!;

    const result = await readTool.execute(
      'read-ambiguous',
      { path: 'docs/knowledge.md' },
      undefined,
      undefined,
      undefined as never,
    );

    // 仍返回第一个 skill 的内容（行为不变），但带回其余命中 skill 名并在 output 提示
    expect(result.details).toMatchObject({
      isError: false,
      otherSkillMatches: ['second-bazi'],
    });
    expect(result.content[0].text).toContain('FIRST 的内容');
    expect(result.content[0].text).toContain('second-bazi');
    expect(result.content[0].text).toContain('多个授权 Skill');
  });

  it('does not expose FateClaw deterministic or legacy domain-specific tools as Pi custom tools', () => {
    const tools = createTools({
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
