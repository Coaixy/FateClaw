import type {
  PaipanCatalogItemDto,
  SkillContextEntryDto,
} from '@fateclaw/contracts/chat';

import { getResolvedEnabledOfficialSkillNames } from '#infrastructure/db';
import {
  getPaipanRegistryEntry,
  listPaipanRegistry,
  type PaipanRegistryEntry,
  type SkillParamProperty,
  type SkillParamType,
  type SkillParametersSchema,
} from './paipan-registry.js';
import { formatOfficialPaipan } from './paipan-formatters.js';

const PAIPAN_SKILL_DIRS = new Set(
  listPaipanRegistry().map((skill) => skill.dir),
);

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
  boards: PaipanRegistryEntry[],
): PaipanRegistryEntry | undefined {
  return boards.find((skill) => skill.dir === skillDir);
}

async function loadAvailablePaipanSkillCatalog(
  userId?: string,
): Promise<PaipanRegistryEntry[]> {
  const enabledSkillNames = new Set(
    await getResolvedEnabledOfficialSkillNames(userId),
  );
  return listPaipanRegistry().filter(
    (skill) =>
      PAIPAN_SKILL_DIRS.has(skill.dir) && enabledSkillNames.has(skill.name),
  );
}

export function isDirectPaipanSkill(skillDir: string): boolean {
  return PAIPAN_SKILL_DIRS.has(skillDir);
}

export async function listDirectPaipanCatalog(
  userId?: string,
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
  userId?: string;
  skillDir: string;
}): Promise<PaipanRegistryEntry> {
  if (!isDirectPaipanSkill(args.skillDir)) {
    throw new DirectPaipanError(
      'PAIPAN.SKILL_UNSUPPORTED',
      '当前只支持系统排盘的纯排盘直出',
      400,
    );
  }

  const skills = await loadAvailablePaipanSkillCatalog(args.userId);
  const skill = getPaipanSkillCatalogEntry(args.skillDir, skills);
  if (skill) {
    return skill;
  }

  const catalogEntry = getPaipanRegistryEntry(args.skillDir);
  if (!catalogEntry) {
    throw new DirectPaipanError(
      'PAIPAN.SKILL_NOT_FOUND',
      `未找到排盘 "${args.skillDir}"`,
      404,
    );
  }

  throw new DirectPaipanError(
    'PAIPAN.SKILL_NOT_ENABLED',
    `排盘 "${catalogEntry.name}" 当前未启用`,
    403,
  );
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
    // 用 Object.hasOwn 判定而非依赖 properties[key] 真值：后者沿原型链取值，会把
    // toString/constructor/__proto__ 等键误判为「已声明」而进入类型校验、抛出误导性 400，
    // 而非走下面的剔除分支。（Object.entries 返回快照，迭代中 delete data[key] 安全。）
    const prop = Object.hasOwn(properties, key) ? properties[key] : undefined;
    if (!prop) {
      // 剔除顶层白名单外的键：schema 未声明的顶层参数绝不透传给底层排盘库，杜绝「未声明数值参数
      // （如 bazi 的 decadeCount）被透传后触发底层无界循环」这类 DoS。
      // 注意：仅作用于顶层键，不递归剔除嵌套对象/数组内的键；已核对所有 runner 只解构各自 schema
      // 声明的字段、不整体透传嵌套对象，故当前无未声明的嵌套字段进入底层库。
      delete data[key];
      continue;
    }
    validateFieldType(key, value, prop);
    validateFieldValue(key, value, prop);
  }

  return data;
}

async function executeInternalPaipan(args: {
  skill: PaipanRegistryEntry;
  input: Record<string, unknown>;
}): Promise<unknown> {
  if (!PAIPAN_SKILL_DIRS.has(args.skill.dir)) {
    throw new DirectPaipanError(
      'PAIPAN.SKILL_UNSUPPORTED',
      '当前只支持系统内置排盘',
      400,
    );
  }

  const validatedInput = validateDirectPaipanInput(
    args.input,
    args.skill.parameters,
  );
  try {
    return await args.skill.runner(validatedInput);
  } catch (error) {
    throw new DirectPaipanError(
      'PAIPAN.EXECUTION_FAILED',
      error instanceof Error ? error.message : '排盘执行失败',
      500,
    );
  }
}

export async function executeDirectPaipan(args: {
  accountId: string;
  userId?: string;
  skillDir: string;
  input: Record<string, unknown>;
}): Promise<{
  skill: PaipanRegistryEntry;
  requestSummary: string;
  sessionTitle: string;
  skillContextEntry: SkillContextEntryDto;
}> {
  const skill = await resolveDirectPaipanSkillOrThrow({
    userId: args.userId,
    skillDir: args.skillDir,
  });
  const title = skill.name;

  void args.accountId;
  const artifactData = await executeInternalPaipan({
    skill,
    input: args.input,
  });
  const output = formatOfficialPaipan(skill.dir, artifactData);

  return {
    skill,
    requestSummary: title,
    sessionTitle: title,
    skillContextEntry: {
      skill: skill.dir,
      output,
      artifactType: `skill.${skill.dir}`,
      artifactTitle: title,
      artifactData,
    },
  };
}
