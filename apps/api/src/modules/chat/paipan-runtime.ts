import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import type {
  PaipanCatalogItemDto,
  SkillContextEntryDto,
} from '@fateclaw/contracts/chat';

import { getResolvedEnabledOfficialSkillNames } from '../../infrastructure/db.js';
import { TIMEZONE, SKILL_API_BASE } from '../../infrastructure/config.js';
import { pickSystemEnv } from '../../infrastructure/process-env.js';
import { resolveOfficialSkillsDir } from '../../infrastructure/official-skills-path.js';
import {
  loadOfficialSkillCatalog,
  type OfficialSkillCatalogEntry,
  type SkillParamProperty,
  type SkillParamType,
  type SkillParametersSchema,
} from '../skills/skill-manifest.js';

const SKILLS_DIR = resolveOfficialSkillsDir();
const DIRECT_PAIPAN_SCRIPT_TIMEOUT_MS = 30_000;
const DIRECT_PAIPAN_SCRIPT_MAX_OUTPUT = 30_000;
const PAIPAN_SKILL_DIRS = new Set([
  'bazi-paipan',
  'ziwei-paipan',
  'iching-paipan',
  'jingzhan-paipan',
  'qimen-paipan',
]);
const OFFICIAL_SCRIPT_DEPENDENCY_PACKAGES = [
  'bazi-ts-lib',
  'iching-shifa',
  'iztro',
  'kinqimen',
] as const;

export class DirectPaipanError extends Error {
  constructor(
    public code:
      | 'PAIPAN.SKILL_NOT_FOUND'
      | 'PAIPAN.SKILL_NOT_ENABLED'
      | 'PAIPAN.SKILL_UNSUPPORTED'
      | 'PAIPAN.PARAM_INVALID'
      | 'PAIPAN.EXECUTION_FAILED',
    message: string,
    public statusCode: number,
  ) {
    super(message);
  }
}

function getPaipanSkillCatalogEntry(
  skillDir: string,
  officialSkills: OfficialSkillCatalogEntry[],
): OfficialSkillCatalogEntry | undefined {
  return officialSkills.find((skill) => skill.dir === skillDir);
}

async function loadAvailablePaipanSkillCatalog(
  userId: string,
): Promise<OfficialSkillCatalogEntry[]> {
  const enabledSkillNames = new Set(
    await getResolvedEnabledOfficialSkillNames(userId),
  );
  return loadOfficialSkillCatalog(SKILLS_DIR).filter(
    (skill) =>
      PAIPAN_SKILL_DIRS.has(skill.dir) &&
      skill.entry?.type === 'script' &&
      enabledSkillNames.has(skill.name),
  );
}

export function isDirectPaipanSkill(skillDir: string): boolean {
  return PAIPAN_SKILL_DIRS.has(skillDir);
}

export async function listDirectPaipanCatalog(
  userId: string,
): Promise<PaipanCatalogItemDto[]> {
  const skills = await loadAvailablePaipanSkillCatalog(userId);
  return skills.map((skill) => ({
    skill: skill.dir,
    name: skill.name,
    description: skill.description,
    parameters: skill.parameters,
    examples: skill.parameters?.examples,
  }));
}

export async function resolveDirectPaipanSkillOrThrow(args: {
  userId: string;
  skillDir: string;
}): Promise<OfficialSkillCatalogEntry> {
  if (!isDirectPaipanSkill(args.skillDir)) {
    throw new DirectPaipanError(
      'PAIPAN.SKILL_UNSUPPORTED',
      '当前只支持官方排盘类 Skill 的纯排盘直出',
      400,
    );
  }

  const skills = await loadAvailablePaipanSkillCatalog(args.userId);
  const skill = getPaipanSkillCatalogEntry(args.skillDir, skills);
  if (skill) {
    return skill;
  }

  const officialSkill = getPaipanSkillCatalogEntry(
    args.skillDir,
    loadOfficialSkillCatalog(SKILLS_DIR),
  );
  if (!officialSkill) {
    throw new DirectPaipanError(
      'PAIPAN.SKILL_NOT_FOUND',
      `未找到排盘 Skill "${args.skillDir}"`,
      404,
    );
  }

  throw new DirectPaipanError(
    'PAIPAN.SKILL_NOT_ENABLED',
    `Skill "${officialSkill.name}" 当前未启用`,
    403,
  );
}

function parseArtifactPayload(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    throw new DirectPaipanError(
      'PAIPAN.EXECUTION_FAILED',
      '排盘脚本返回了无法解析的结果',
      500,
    );
  }
}

function resolveScriptNodeModulesDir(skillsDir: string): string {
  return path.resolve(skillsDir, '..', 'node_modules');
}

function resolveFallbackNodeModulesDirs(skillsDir: string): string[] {
  const projectRoot = path.resolve(skillsDir, '..', '..');
  return [
    path.join(projectRoot, 'apps', 'api', 'node_modules'),
    path.join(projectRoot, 'packages', 'agent-runner', 'node_modules'),
  ];
}

function ensureOfficialScriptDependenciesAccessible(skillsDir: string): void {
  const skillNodeModulesDir = resolveScriptNodeModulesDir(skillsDir);
  const fallbackDirs = resolveFallbackNodeModulesDirs(skillsDir).filter((dir) =>
    fs.existsSync(dir),
  );

  if (fallbackDirs.length === 0) {
    return;
  }

  fs.mkdirSync(skillNodeModulesDir, { recursive: true });

  for (const packageName of OFFICIAL_SCRIPT_DEPENDENCY_PACKAGES) {
    const targetPath = path.join(skillNodeModulesDir, packageName);
    if (fs.existsSync(targetPath)) {
      continue;
    }

    const sourcePath = fallbackDirs
      .map((dir) => path.join(dir, packageName))
      .find((candidate) => fs.existsSync(candidate));
    if (!sourcePath) {
      continue;
    }

    fs.symlinkSync(
      sourcePath,
      targetPath,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }
}

function isMissingValue(value: unknown): boolean {
  return value === undefined || value === null;
}

function matchesSingleType(value: unknown, type: SkillParamType): boolean {
  switch (type) {
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return (
        typeof value === 'object' && value !== null && !Array.isArray(value)
      );
  }
}

function formatFieldList(fields: string[]): string {
  return fields.join('、');
}

function describeType(type: SkillParamType | SkillParamType[]): string {
  return Array.isArray(type) ? type.join(' | ') : type;
}

function validateFieldType(
  key: string,
  value: unknown,
  prop: SkillParamProperty,
): void {
  const expectedTypes = Array.isArray(prop.type) ? prop.type : [prop.type];
  if (expectedTypes.some((type) => matchesSingleType(value, type))) {
    return;
  }

  const actualType = Array.isArray(value) ? 'array' : typeof value;
  throw new DirectPaipanError(
    'PAIPAN.PARAM_INVALID',
    `参数 "${key}" 类型错误: 期望 ${describeType(prop.type)}，实际 ${actualType}`,
    400,
  );
}

function validateFieldValue(
  key: string,
  value: unknown,
  prop: SkillParamProperty,
): void {
  if (prop.enum !== undefined && !prop.enum.includes(value)) {
    const enumStr = prop.enum.map((item) => JSON.stringify(item)).join(', ');
    throw new DirectPaipanError(
      'PAIPAN.PARAM_INVALID',
      `参数 "${key}" 的值 ${JSON.stringify(value)} 不合法，允许值: [${enumStr}]`,
      400,
    );
  }

  if (typeof value === 'number') {
    if (prop.minimum !== undefined && value < prop.minimum) {
      throw new DirectPaipanError(
        'PAIPAN.PARAM_INVALID',
        `参数 "${key}" 不能小于 ${prop.minimum}`,
        400,
      );
    }
    if (prop.maximum !== undefined && value > prop.maximum) {
      throw new DirectPaipanError(
        'PAIPAN.PARAM_INVALID',
        `参数 "${key}" 不能大于 ${prop.maximum}`,
        400,
      );
    }
  }

  if (Array.isArray(value)) {
    if (prop.minItems !== undefined && value.length < prop.minItems) {
      throw new DirectPaipanError(
        'PAIPAN.PARAM_INVALID',
        `参数 "${key}" 数组长度不能少于 ${prop.minItems}`,
        400,
      );
    }
    if (prop.maxItems !== undefined && value.length > prop.maxItems) {
      throw new DirectPaipanError(
        'PAIPAN.PARAM_INVALID',
        `参数 "${key}" 数组长度不能超过 ${prop.maxItems}`,
        400,
      );
    }
    if (prop.items?.enum) {
      for (let i = 0; i < value.length; i += 1) {
        if (!prop.items.enum.includes(value[i])) {
          const enumStr = prop.items.enum
            .map((item) => JSON.stringify(item))
            .join(', ');
          throw new DirectPaipanError(
            'PAIPAN.PARAM_INVALID',
            `参数 "${key}[${i}]" 的值 ${JSON.stringify(value[i])} 不合法，允许值: [${enumStr}]`,
            400,
          );
        }
      }
    }
  }
}

function validateDirectPaipanInput(
  input: Record<string, unknown>,
  schema: SkillParametersSchema | undefined,
): Record<string, unknown> {
  if (!schema) {
    return input;
  }

  const data: Record<string, unknown> = { ...input };
  const { properties = {}, required = [] } = schema;

  for (const [key, prop] of Object.entries(properties)) {
    if (!(key in data) && prop.default !== undefined) {
      data[key] = prop.default;
    }
  }

  for (const field of required) {
    if (!(field in data) || isMissingValue(data[field])) {
      const desc = properties[field]?.description;
      throw new DirectPaipanError(
        'PAIPAN.PARAM_INVALID',
        `缺少必填参数 "${field}"${desc ? `（${desc}）` : ''}`,
        400,
      );
    }
  }

  for (const requirement of schema.conditionalRequired ?? []) {
    if (data[requirement.when.field] !== requirement.when.equals) {
      continue;
    }
    const missing = requirement.required.filter(
      (field) => !(field in data) || isMissingValue(data[field]),
    );
    if (missing.length > 0) {
      throw new DirectPaipanError(
        'PAIPAN.PARAM_INVALID',
        requirement.description ||
          `当 ${requirement.when.field}=${JSON.stringify(requirement.when.equals)} 时，必须提供 ${formatFieldList(missing)}`,
        400,
      );
    }
  }

  for (const fields of schema.atLeastOneOf ?? []) {
    if (
      fields.length > 0 &&
      !fields.some((field) => field in data && !isMissingValue(data[field]))
    ) {
      throw new DirectPaipanError(
        'PAIPAN.PARAM_INVALID',
        `${formatFieldList(fields)} 至少提供一个`,
        400,
      );
    }
  }

  for (const fields of schema.allOrNoneOf ?? []) {
    if (fields.length < 2) continue;
    const provided = fields.filter(
      (field) => field in data && !isMissingValue(data[field]),
    );
    if (provided.length === 0 || provided.length === fields.length) {
      continue;
    }
    const missing = fields.filter((field) => !provided.includes(field));
    throw new DirectPaipanError(
      'PAIPAN.PARAM_INVALID',
      `${formatFieldList(fields)} 必须同时提供或同时不提供；当前缺少 ${formatFieldList(missing)}`,
      400,
    );
  }

  for (const [key, value] of Object.entries(data)) {
    const prop = properties[key];
    if (!prop) continue;
    validateFieldType(key, value, prop);
    validateFieldValue(key, value, prop);
  }

  return data;
}

function resolveScriptInterpreter(script: string): string | null {
  const ext = path.extname(script).toLowerCase();
  switch (ext) {
    case '.sh':
      return '/bin/bash';
    case '.py':
      return 'python3';
    case '.js':
      return process.execPath;
    default:
      return null;
  }
}

function buildPaipanScriptEnv(args: {
  accountId: string;
  userId: string;
  skillDir: string;
  skillPath: string;
}): Record<string, string> {
  return {
    ...pickSystemEnv(),
    FATECLAW_ACCOUNT_ID: args.accountId,
    FATECLAW_USER_ID: args.userId,
    FATECLAW_TIMEZONE: TIMEZONE,
    SKILL_NAME: args.skillDir,
    SKILL_DIR: args.skillPath,
    SKILL_API_BASE,
    TZ: TIMEZONE,
  };
}

async function executeOfficialPaipanScript(args: {
  accountId: string;
  userId: string;
  skill: OfficialSkillCatalogEntry;
  input: Record<string, unknown>;
}): Promise<string> {
  const script =
    args.skill.entry?.type === 'script' ? args.skill.entry.file : null;
  if (!script) {
    throw new DirectPaipanError(
      'PAIPAN.SKILL_UNSUPPORTED',
      '当前只支持官方排盘脚本',
      400,
    );
  }

  const interpreter = resolveScriptInterpreter(script);
  if (!interpreter) {
    throw new DirectPaipanError(
      'PAIPAN.SKILL_UNSUPPORTED',
      `不支持的排盘脚本类型: ${script}`,
      400,
    );
  }

  const skillPath = path.join(SKILLS_DIR, args.skill.dir);
  const scriptPath = path.join(skillPath, script);
  if (!fs.existsSync(scriptPath)) {
    throw new DirectPaipanError(
      'PAIPAN.SKILL_NOT_FOUND',
      `排盘脚本不存在: ${args.skill.dir}/${script}`,
      404,
    );
  }

  ensureOfficialScriptDependenciesAccessible(SKILLS_DIR);
  const stdin = JSON.stringify(
    validateDirectPaipanInput(args.input, args.skill.parameters),
  );

  return new Promise((resolve, reject) => {
    const child = execFile(
      interpreter,
      [scriptPath],
      {
        cwd: skillPath,
        timeout: DIRECT_PAIPAN_SCRIPT_TIMEOUT_MS,
        maxBuffer: DIRECT_PAIPAN_SCRIPT_MAX_OUTPUT * 2,
        env: buildPaipanScriptEnv({
          accountId: args.accountId,
          userId: args.userId,
          skillDir: args.skill.dir,
          skillPath,
        }),
      },
      (error, stdout, stderr) => {
        const trimmedStdout = (stdout || '').trim();
        const trimmedStderr = (stderr || '').trim();
        if (error) {
          const timedOut = Boolean('killed' in error && error.killed);
          reject(
            new DirectPaipanError(
              'PAIPAN.EXECUTION_FAILED',
              timedOut
                ? '排盘脚本执行超时，请稍后重试'
                : trimmedStderr || trimmedStdout || error.message,
              500,
            ),
          );
          return;
        }
        resolve(trimmedStdout.slice(0, DIRECT_PAIPAN_SCRIPT_MAX_OUTPUT));
      },
    );

    child.on('error', (error) => {
      reject(
        new DirectPaipanError(
          'PAIPAN.EXECUTION_FAILED',
          error.message || '排盘脚本启动失败',
          500,
        ),
      );
    });

    child.stdin?.write(stdin);
    child.stdin?.end();
  });
}

export async function executeDirectPaipan(args: {
  accountId: string;
  userId: string;
  skillDir: string;
  input: Record<string, unknown>;
  displayNote?: string;
}): Promise<{
  skill: OfficialSkillCatalogEntry;
  requestSummary: string;
  sessionTitle: string;
  skillContextEntry: SkillContextEntryDto;
}> {
  const skill = await resolveDirectPaipanSkillOrThrow({
    userId: args.userId,
    skillDir: args.skillDir,
  });
  const title = args.displayNote
    ? `${skill.name} · ${args.displayNote}`
    : skill.name;

  const output = await executeOfficialPaipanScript({
    accountId: args.accountId,
    userId: args.userId,
    skill,
    input: args.input,
  });

  return {
    skill,
    requestSummary: title,
    sessionTitle: title,
    skillContextEntry: {
      skill: skill.dir,
      output,
      artifactType: `skill.${skill.dir}`,
      artifactTitle: title,
      artifactData: parseArtifactPayload(output),
    },
  };
}
