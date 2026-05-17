import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import type {
  PaipanCatalogItemDto,
  SkillContextEntryDto,
} from '@nanoclaw/contracts/chat';

import { getResolvedEnabledOfficialSkillNames } from '../../infrastructure/db.js';
import { resolveOfficialSkillsDir } from '../../infrastructure/official-skills-path.js';
import { pickSystemEnv } from '../../infrastructure/process-env.js';
import {
  loadOfficialSkillCatalog,
  type OfficialSkillCatalogEntry,
  type SkillParamProperty,
  type SkillParamType,
  type SkillParametersSchema,
} from '../skills/skill-manifest.js';

const SKILLS_DIR = resolveOfficialSkillsDir();
const PAIPAN_SKILL_DIRS = new Set([
  'bazi-paipan',
  'ziwei-paipan',
  'iching-paipan',
  'jingzhan-paipan',
  'qimen-paipan',
]);
const SKILL_SCRIPT_TIMEOUT = 30_000;
const SKILL_SCRIPT_MAX_OUTPUT = 30_000;
const SKILL_RUNTIME_DEPENDENCY_PACKAGES = [
  'bazi-ts-lib',
  'iching-shifa',
  'iztro',
  'kinqimen',
] as const;

type ValidationContext = {
  path: string;
};

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

function cloneDefaultValue<T>(value: T): T {
  return structuredClone(value);
}

function isMissingValue(value: unknown): boolean {
  return value === undefined || value === null;
}

function resolveSkillNodeModulesDir(skillsDir: string): string {
  return path.resolve(skillsDir, '..', 'node_modules');
}

function resolveFallbackNodeModulesDirs(skillsDir: string): string[] {
  const projectRoot = path.resolve(skillsDir, '..', '..');
  return [
    path.join(projectRoot, 'apps', 'api', 'node_modules'),
    path.join(projectRoot, 'packages', 'agent-runner', 'node_modules'),
  ];
}

/**
 * 保证官方排盘脚本能解析到运行时依赖。
 * 常规情况下依赖应位于 skills/node_modules；旧部署缺失时按需补符号链接。
 */
export function ensurePaipanRuntimeDependenciesAccessible(
  skillsDir: string = SKILLS_DIR,
): void {
  const skillNodeModulesDir = resolveSkillNodeModulesDir(skillsDir);
  const fallbackDirs = resolveFallbackNodeModulesDirs(skillsDir).filter((dir) =>
    fs.existsSync(dir),
  );

  if (fallbackDirs.length === 0) {
    return;
  }

  fs.mkdirSync(skillNodeModulesDir, { recursive: true });

  for (const packageName of SKILL_RUNTIME_DEPENDENCY_PACKAGES) {
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

function isSkillParamType(value: string): value is SkillParamType {
  return (
    value === 'string' ||
    value === 'number' ||
    value === 'integer' ||
    value === 'boolean' ||
    value === 'array' ||
    value === 'object'
  );
}

function matchesSingleType(value: unknown, type: SkillParamType): boolean {
  switch (type) {
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
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
  return false;
}

function describeTypes(type: SkillParamType | SkillParamType[]): string {
  return Array.isArray(type) ? type.join(' / ') : type;
}

function buildFieldPath(parentPath: string, key: string): string {
  return parentPath ? `${parentPath}.${key}` : key;
}

function buildParamError(message: string): never {
  throw new DirectPaipanError('PAIPAN.PARAM_INVALID', message, 400);
}

function normalizeObjectDefaults(
  value: Record<string, unknown>,
  schema: SkillParametersSchema,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...value };
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (!(key in normalized) && prop.default !== undefined) {
      normalized[key] = cloneDefaultValue(prop.default);
    }
    if (
      key in normalized &&
      normalized[key] &&
      typeof normalized[key] === 'object' &&
      !Array.isArray(normalized[key]) &&
      prop.properties
    ) {
      normalized[key] = normalizeObjectDefaults(
        normalized[key] as Record<string, unknown>,
        {
          type: 'object',
          properties: prop.properties,
          required: prop.required,
        },
      );
    }
  }
  return normalized;
}

function validateArrayItems(
  fieldPath: string,
  items: unknown[],
  property: SkillParamProperty,
): void {
  if (!property.items) {
    return;
  }

  const itemType = property.items.type;
  if (!isSkillParamType(itemType)) {
    buildParamError(`参数 "${fieldPath}" 的数组元素类型配置无效`);
  }

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const itemPath = `${fieldPath}[${index}]`;
    if (!matchesSingleType(item, itemType)) {
      buildParamError(
        `参数 "${itemPath}" 类型错误，期望 ${itemType}，实际 ${
          Array.isArray(item) ? 'array' : typeof item
        }`,
      );
    }
    if (
      property.items.enum &&
      property.items.enum.length > 0 &&
      !property.items.enum.some((candidate) => candidate === item)
    ) {
      buildParamError(
        `参数 "${itemPath}" 必须是 ${property.items.enum.join(' / ')} 之一`,
      );
    }
  }
}

function validatePropertyValue(
  fieldPath: string,
  value: unknown,
  property: SkillParamProperty,
): unknown {
  const expectedTypes = Array.isArray(property.type)
    ? property.type
    : [property.type];
  if (!expectedTypes.some((type) => matchesSingleType(value, type))) {
    buildParamError(
      `参数 "${fieldPath}" 类型错误，期望 ${describeTypes(property.type)}，实际 ${
        Array.isArray(value) ? 'array' : typeof value
      }`,
    );
  }

  if (
    property.enum &&
    property.enum.length > 0 &&
    !property.enum.some((candidate) => candidate === value)
  ) {
    buildParamError(
      `参数 "${fieldPath}" 必须是 ${property.enum.join(' / ')} 之一`,
    );
  }

  if (typeof value === 'number') {
    if (typeof property.minimum === 'number' && value < property.minimum) {
      buildParamError(`参数 "${fieldPath}" 不能小于 ${property.minimum}`);
    }
    if (typeof property.maximum === 'number' && value > property.maximum) {
      buildParamError(`参数 "${fieldPath}" 不能大于 ${property.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (
      typeof property.minItems === 'number' &&
      value.length < property.minItems
    ) {
      buildParamError(`参数 "${fieldPath}" 至少需要 ${property.minItems} 项`);
    }
    if (
      typeof property.maxItems === 'number' &&
      value.length > property.maxItems
    ) {
      buildParamError(`参数 "${fieldPath}" 最多只能有 ${property.maxItems} 项`);
    }
    validateArrayItems(fieldPath, value, property);
    return value;
  }

  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    property.properties
  ) {
    return validateObjectValue(
      value as Record<string, unknown>,
      {
        type: 'object',
        properties: property.properties,
        required: property.required,
      },
      { path: fieldPath },
    );
  }

  return value;
}

function validateObjectValue(
  input: Record<string, unknown>,
  schema: SkillParametersSchema,
  context: ValidationContext,
): Record<string, unknown> {
  const data = normalizeObjectDefaults(input, schema);

  for (const field of schema.required ?? []) {
    if (!(field in data) || isMissingValue(data[field])) {
      const description = schema.properties[field]?.description;
      buildParamError(
        description
          ? `缺少必填参数 "${buildFieldPath(context.path, field)}"（${description}）`
          : `缺少必填参数 "${buildFieldPath(context.path, field)}"`,
      );
    }
  }

  for (const requirement of schema.conditionalRequired ?? []) {
    if (data[requirement.when.field] !== requirement.when.equals) {
      continue;
    }
    const missingFields = requirement.required.filter(
      (field) => !(field in data) || isMissingValue(data[field]),
    );
    if (missingFields.length > 0) {
      buildParamError(
        requirement.description ||
          `当 ${buildFieldPath(context.path, requirement.when.field)}=${JSON.stringify(
            requirement.when.equals,
          )} 时，必须提供 ${missingFields
            .map((field) => buildFieldPath(context.path, field))
            .join('、')}`,
      );
    }
  }

  for (const fields of schema.atLeastOneOf ?? []) {
    if (fields.length === 0) {
      continue;
    }
    const satisfied = fields.some(
      (field) => field in data && !isMissingValue(data[field]),
    );
    if (!satisfied) {
      buildParamError(
        `${fields
          .map((field) => buildFieldPath(context.path, field))
          .join('、')} 至少提供一个`,
      );
    }
  }

  for (const fields of schema.allOrNoneOf ?? []) {
    if (fields.length < 2) {
      continue;
    }
    const provided = fields.filter(
      (field) => field in data && !isMissingValue(data[field]),
    );
    if (provided.length === 0 || provided.length === fields.length) {
      continue;
    }
    const missing = fields.filter((field) => !provided.includes(field));
    buildParamError(
      `${fields
        .map((field) => buildFieldPath(context.path, field))
        .join('、')} 需要成组提供；当前缺少 ${missing
        .map((field) => buildFieldPath(context.path, field))
        .join('、')}`,
    );
  }

  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    if (!(key in data) || isMissingValue(data[key])) {
      continue;
    }
    data[key] = validatePropertyValue(
      buildFieldPath(context.path, key),
      data[key],
      property,
    );
  }

  return data;
}

function validateAndNormalizeInput(
  input: Record<string, unknown>,
  schema?: SkillParametersSchema,
): Record<string, unknown> {
  if (!schema) {
    return input;
  }
  return validateObjectValue(input, schema, { path: '' });
}

function resolveInterpreter(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  // 使用当前 Node 可执行文件，避免 Windows 服务环境 PATH 缺失时找不到 `node`。
  if (ext === '.js') return process.execPath;
  if (ext === '.py') return 'python3';
  if (ext === '.sh') return '/bin/bash';
  throw new DirectPaipanError(
    'PAIPAN.SKILL_UNSUPPORTED',
    `暂不支持脚本类型 "${ext}"`,
    500,
  );
}

function buildExecutionEnv(args: {
  accountId: string;
  userId: string;
  skill: OfficialSkillCatalogEntry;
  skillDir: string;
}): Record<string, string> {
  const env: Record<string, string | undefined> = {
    ...pickSystemEnv(),
    HUSHBAY_ACCOUNT_ID: args.accountId,
    HUSHBAY_USER_ID: args.userId,
    HUSHBAY_TIMEZONE: 'Asia/Shanghai',
    SKILL_NAME: args.skill.dir,
    SKILL_DIR: args.skillDir,
    TZ: process.env.TZ || 'Asia/Shanghai',
  };

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value) {
      result[key] = value;
    }
  }
  return result;
}

function parseScriptError(stderr: string, fallback: string): string {
  const trimmed = stderr.trim();
  if (!trimmed) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error.trim()) {
      return parsed.error.trim();
    }
  } catch {
    // ignore
  }
  return trimmed.slice(0, 300) || fallback;
}

async function executeScript(args: {
  accountId: string;
  userId: string;
  skill: OfficialSkillCatalogEntry;
  skillDir: string;
  input: Record<string, unknown>;
}): Promise<string> {
  const entry = args.skill.entry;
  if (!entry || entry.type !== 'script') {
    throw new DirectPaipanError(
      'PAIPAN.SKILL_UNSUPPORTED',
      `Skill "${args.skill.dir}" 不支持纯排盘直执行`,
      400,
    );
  }

  ensurePaipanRuntimeDependenciesAccessible(SKILLS_DIR);

  const interpreter = resolveInterpreter(entry.file);
  const scriptPath = path.join(args.skillDir, entry.file);
  if (!fs.existsSync(scriptPath)) {
    throw new DirectPaipanError(
      'PAIPAN.SKILL_UNSUPPORTED',
      `Skill "${args.skill.dir}" 的脚本文件不存在`,
      500,
    );
  }

  const stdin = JSON.stringify(args.input);

  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      interpreter,
      [scriptPath],
      {
        timeout: SKILL_SCRIPT_TIMEOUT,
        maxBuffer: SKILL_SCRIPT_MAX_OUTPUT * 2,
        cwd: args.skillDir,
        env: buildExecutionEnv(args),
      },
      (error, stdout, stderr) => {
        if (error) {
          const errorWithState = error as NodeJS.ErrnoException & {
            killed?: boolean;
          };
          const reason = errorWithState.killed
            ? `排盘执行超时（${SKILL_SCRIPT_TIMEOUT}ms）`
            : parseScriptError(stderr, error.message);
          reject(new DirectPaipanError('PAIPAN.EXECUTION_FAILED', reason, 400));
          return;
        }

        const trimmed = stdout.trim();
        if (!trimmed) {
          reject(
            new DirectPaipanError(
              'PAIPAN.EXECUTION_FAILED',
              '排盘脚本未返回结果',
              500,
            ),
          );
          return;
        }

        resolve(trimmed);
      },
    );

    child.stdin?.end(stdin);
  });
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
  const normalizedInput = validateAndNormalizeInput(
    args.input,
    skill.parameters,
  );
  const skillDirPath = path.join(SKILLS_DIR, skill.dir);
  const output = await executeScript({
    accountId: args.accountId,
    userId: args.userId,
    skill,
    skillDir: skillDirPath,
    input: normalizedInput,
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
