import fs from 'fs';
import path from 'path';

import { parse as parseYaml } from 'yaml';

import { resolveOfficialSkillsDir } from '../../infrastructure/official-skills-path.js';

export type SkillParamType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'array'
  | 'object';

export interface SkillParamProperty {
  type: SkillParamType | SkillParamType[];
  description: string;
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: { type: SkillParamType; enum?: unknown[] };
  properties?: Record<string, SkillParamProperty>;
  required?: string[];
}

export interface SkillConditionalRequirement {
  when: {
    field: string;
    equals: unknown;
  };
  required: string[];
  description?: string;
}

export interface SkillExamplePayload {
  name?: string;
  description?: string;
  value: Record<string, unknown>;
}

export interface SkillParametersSchema {
  type: 'object';
  properties: Record<string, SkillParamProperty>;
  required?: string[];
  conditionalRequired?: SkillConditionalRequirement[];
  atLeastOneOf?: string[][];
  allOrNoneOf?: string[][];
  examples?: SkillExamplePayload[];
}

export type SkillEntry =
  | {
      type: 'script';
      file: string;
    }
  | {
      type: 'tool';
      tool: string;
      fallbackScript?: string;
    };

export interface OfficialSkillCatalogEntry {
  dir: string;
  name: string;
  description: string;
  trigger: string;
  entry?: SkillEntry;
  parameters?: SkillParametersSchema;
  manifestSource: 'SKILL.md';
  manifestVersion?: number;
  requiresLoad?: boolean;
}

interface OfficialSkillRuntimeConfig {
  displayName: string;
  trigger: string;
  entry?: SkillEntry;
  parameters?: SkillParametersSchema;
  manifestVersion?: number;
  requiresLoad?: boolean;
}

interface SkillMarkdownDescriptor {
  frontmatter: Record<string, unknown>;
  title?: string;
}

const ichingLikeParameters: SkillParametersSchema = {
  type: 'object',
  properties: {
    method: {
      type: 'string',
      description: '起卦方式',
      enum: ['dayan', 'lueshifa', 'manual', 'three', 'array', 'time'],
      default: 'dayan',
    },
    yao: {
      type: 'string',
      description:
        'method=manual 时必填：6 位爻字符串，每位取值 6/7/8/9（6=老阴动、7=少阳、8=少阴、9=老阳动），从初爻到上爻。例 "789678"',
    },
    numbers: {
      type: 'array',
      description: 'method=three 时长度必须为 3；method=array 时长度 >= 2',
      items: { type: 'integer' },
    },
    datetime: {
      type: 'string',
      description: '排盘时间，格式 "YYYY-MM-DD HH:mm"，默认当前时间',
    },
    question: {
      type: 'string',
      description: '可选：问卜主题（原样回传，不参与排盘计算）',
    },
  },
};

const OFFICIAL_SKILL_RUNTIME_CONFIG: Record<
  string,
  OfficialSkillRuntimeConfig
> = {
  'bazi-paipan': {
    displayName: '八字排盘',
    trigger: '用户询问八字、四柱、大运、流年、格局等命理相关问题',
    entry: { type: 'script', file: 'paipan.js' },
    manifestVersion: 2,
    requiresLoad: false,
    parameters: {
      type: 'object',
      properties: {
        solarDate: {
          type: 'string',
          description: '阳历出生日期 YYYY-MM-DD',
        },
        hour: {
          type: 'integer',
          description: '出生小时 0-23（24 小时制）',
          minimum: 0,
          maximum: 23,
        },
        minute: {
          type: 'integer',
          description: '出生分钟 0-59',
          minimum: 0,
          maximum: 59,
          default: 0,
        },
        gender: {
          type: 'string',
          description: '性别',
          enum: ['男', '女', 'male', 'female'],
        },
        zishiMode: {
          type: 'string',
          description: '子时切换：early=23:00~00:00 算次日；late=算当日',
          enum: ['early', 'late'],
          default: 'early',
        },
        childLimitMode: {
          type: 'string',
          description: '起运算法',
          enum: ['default', 'china95', 'lunar_sect1', 'lunar_sect2'],
          default: 'default',
        },
        include: {
          type: 'array',
          description: '要返回的部分，默认全部',
          items: {
            type: 'string',
            enum: ['bazi', 'fortune', 'pattern'],
          },
        },
      },
      required: ['solarDate', 'hour', 'gender'],
    },
  },
  'iching-paipan': {
    displayName: '六爻排盘',
    trigger:
      '用户询问六爻、纳甲、六亲、世应、伏神、动爻、用神、飞伏等六爻占卜相关问题',
    entry: { type: 'script', file: 'paipan.js' },
    manifestVersion: 2,
    requiresLoad: false,
    parameters: ichingLikeParameters,
  },
  'jingzhan-paipan': {
    displayName: '经占排盘',
    trigger:
      '用户询问周易、易经、占卜、起卦、大衍筮法、略筮法、卦辞、爻辞等经占排盘相关问题',
    entry: { type: 'script', file: 'paipan.js' },
    manifestVersion: 2,
    requiresLoad: false,
    parameters: ichingLikeParameters,
  },
  'qimen-paipan': {
    displayName: '奇门遁甲排盘',
    trigger:
      '用户询问奇门遁甲、时家奇门、值符值使、八门九星、天地盘相关问题，或需要按指定时间起奇门局',
    entry: { type: 'script', file: 'paipan.js' },
    manifestVersion: 2,
    requiresLoad: false,
    parameters: {
      type: 'object',
      properties: {
        solarDate: {
          type: 'string',
          description: '阳历日期 YYYY-MM-DD。不传则用当前时间',
        },
        hour: {
          type: 'integer',
          description: '小时 0-23（24 小时制）。不传则用当前时间',
          minimum: 0,
          maximum: 23,
        },
        minute: {
          type: 'integer',
          description: '分钟 0-59；与 solarDate/hour 一起传时默认 0',
          minimum: 0,
          maximum: 59,
          default: 0,
        },
      },
      allOrNoneOf: [['solarDate', 'hour']],
      examples: [
        {
          name: '默认当前时间起盘',
          value: {},
        },
        {
          name: '指定时间起盘',
          value: {
            solarDate: '2026-04-17',
            hour: 14,
            minute: 30,
          },
        },
      ],
    },
  },
  'ziwei-paipan': {
    displayName: '紫微斗数排盘',
    trigger: '用户询问紫微斗数、紫微排盘、命宫身宫、大限流年等相关问题',
    entry: { type: 'script', file: 'paipan.js' },
    manifestVersion: 2,
    requiresLoad: false,
    parameters: {
      type: 'object',
      properties: {
        solarDate: {
          type: 'string',
          description: '阳历出生日期，格式 YYYY-MM-DD，例如 2000-08-16',
        },
        hour: {
          type: 'integer',
          description: '出生小时，24 小时制，0-23',
          minimum: 0,
          maximum: 23,
        },
        minute: {
          type: 'integer',
          description: '出生分钟，0-59，用于判断早晚子时边界',
          minimum: 0,
          maximum: 59,
          default: 0,
        },
        gender: {
          type: 'string',
          description: '性别，male 或 female（也接受 男/女）',
          enum: ['male', 'female', '男', '女'],
        },
        fixLeap: {
          type: 'boolean',
          description: '是否修正闰月：前半月作上月，后半月作下月',
          default: true,
        },
        horoscope: {
          type: 'object',
          description: '可选：叠加运盘（大限/小限/流年/流月/流日/流时）',
          properties: {
            date: {
              type: 'string',
              description: '运盘目标日期 YYYY-MM-DD，例如 2026-04-17',
            },
            scopes: {
              type: 'array',
              description: '要返回的运盘尺度，默认 [decadal, yearly]',
              items: {
                type: 'string',
                enum: [
                  'decadal',
                  'age',
                  'yearly',
                  'monthly',
                  'daily',
                  'hourly',
                ],
              },
            },
          },
          required: ['date'],
        },
      },
      required: ['solarDate', 'hour', 'gender'],
    },
  },
};

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function parseFrontmatter(raw: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return { frontmatter: {}, body: raw };
  }
  const parsed = parseYaml(match[1] ?? '');
  const frontmatter =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  return {
    frontmatter,
    body: raw.slice(match[0].length),
  };
}

function readSkillMarkdownDescriptor(
  filePath: string,
): SkillMarkdownDescriptor | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(raw);
    const title = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
    return { frontmatter, title };
  } catch {
    return null;
  }
}

function loadOfficialSkillDescriptor(
  skillDir: string,
  skillPath: string,
): OfficialSkillCatalogEntry | null {
  const skillMarkdownPath = path.join(skillPath, 'SKILL.md');
  if (!fs.existsSync(skillMarkdownPath)) {
    return null;
  }

  const markdown = readSkillMarkdownDescriptor(skillMarkdownPath);
  if (!markdown) {
    return null;
  }

  const config = OFFICIAL_SKILL_RUNTIME_CONFIG[skillDir];
  const name =
    config?.displayName ??
    asString(markdown.frontmatter.title) ??
    markdown.title ??
    asString(markdown.frontmatter.name) ??
    skillDir;
  const description =
    asString(markdown.frontmatter.description) ?? markdown.title ?? '';
  const trigger =
    asString(markdown.frontmatter.trigger) ?? config?.trigger ?? description;

  return {
    dir: skillDir,
    name,
    description,
    trigger,
    entry: config?.entry,
    parameters: config?.parameters,
    manifestSource: 'SKILL.md',
    manifestVersion:
      asNumber(markdown.frontmatter.manifestVersion) ?? config?.manifestVersion,
    requiresLoad:
      asBoolean(markdown.frontmatter.requiresLoad) ??
      config?.requiresLoad ??
      false,
  };
}

export function loadOfficialSkillCatalog(
  skillsDir: string = resolveOfficialSkillsDir(),
): OfficialSkillCatalogEntry[] {
  if (!fs.existsSync(skillsDir)) return [];

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  const skills: OfficialSkillCatalogEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    const skill = loadOfficialSkillDescriptor(
      entry.name,
      path.join(skillsDir, entry.name),
    );
    if (skill) {
      skills.push(skill);
    }
  }

  return skills;
}
