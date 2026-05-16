/**
 * Skill 参数验证器。
 *
 * 在执行 run_skill_script 前对 stdin JSON 进行强类型验证，
 * 包括必填校验、类型校验、枚举约束、数值范围、数组长度，
 * 并自动将 schema 中定义的 default 值填充到缺失的可选字段。
 */

import type {
  SkillParametersSchema,
  SkillParamProperty,
  SkillParamType,
  SkillConditionalRequirement,
} from './prompt/types.js';

export interface ValidationResult {
  /** 验证是否通过。 */
  valid: boolean;
  /** 验证失败时的中文错误说明。 */
  error?: string;
  /** 验证失败时的结构化问题信息。 */
  issue?: ValidationIssue;
  /**
   * 验证通过时的干净数据对象（已填充默认值，可直接序列化为新 stdin）。
   * 验证失败时为 undefined。
   */
  data?: Record<string, unknown>;
}

export type ValidationIssueCode =
  | 'invalid_json'
  | 'invalid_root'
  | 'required'
  | 'conditional_required'
  | 'at_least_one'
  | 'all_or_none'
  | 'type'
  | 'enum'
  | 'minimum'
  | 'maximum'
  | 'min_items'
  | 'max_items'
  | 'item_enum';

export interface ValidationIssue {
  code: ValidationIssueCode;
  fields?: string[];
  /** 成组规则时，记录原始整组字段。 */
  groupFields?: string[];
  description?: string;
  condition?: {
    field: string;
    equals: unknown;
  };
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
      return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}

function describeType(type: SkillParamType | SkillParamType[]): string {
  return Array.isArray(type) ? type.join(' | ') : type;
}

function formatCondition(requirement: SkillConditionalRequirement): string {
  return `${requirement.when.field}=${JSON.stringify(requirement.when.equals)}`;
}

function formatFieldList(fields: string[]): string {
  return fields.join('、');
}

/** 校验单个值的类型，返回错误描述或 null。 */
function checkType(
  value: unknown,
  prop: SkillParamProperty,
  key: string,
): string | null {
  const actualType = Array.isArray(value) ? 'array' : typeof value;
  const expectedTypes = Array.isArray(prop.type) ? prop.type : [prop.type];
  if (!expectedTypes.some((type) => matchesSingleType(value, type))) {
    return `参数 "${key}" 类型错误: 期望 ${describeType(prop.type)}，实际 ${actualType}`;
  }

  return null;
}

/**
 * 验证并清洗 skill stdin 参数。
 *
 * @param stdin  run_skill_script 传入的 stdin 字符串（JSON 格式）。
 * @param schema skill manifest 中定义的 parameters schema。
 * @returns      ValidationResult — valid=true 时 data 字段包含已填充默认值的对象。
 */
export function validateSkillInput(
  stdin: string | undefined,
  schema: SkillParametersSchema | undefined,
): ValidationResult {
  // 无 schema 定义，直接放行
  if (!schema) {
    return { valid: true };
  }

  // 解析 stdin JSON
  let raw: unknown;
  try {
    raw = stdin ? JSON.parse(stdin) : {};
  } catch {
    return {
      valid: false,
      error: 'stdin 不是有效的 JSON 字符串',
      issue: { code: 'invalid_json' },
    };
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      valid: false,
      error: 'stdin 必须是 JSON 对象（{}），不能是数组或基本类型',
      issue: { code: 'invalid_root' },
    };
  }

  const data: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  const { properties = {}, required = [] } = schema;

  // 填充默认值（仅对缺失字段）
  for (const [key, prop] of Object.entries(properties)) {
    if (!(key in data) && prop.default !== undefined) {
      data[key] = prop.default;
    }
  }

  // 必填字段检查
  for (const field of required) {
    if (!(field in data) || isMissingValue(data[field])) {
      const desc = properties[field]?.description;
      return {
        valid: false,
        error: `缺少必填参数 "${field}"${desc ? `（${desc}）` : ''}`,
        issue: {
          code: 'required',
          fields: [field],
          description: desc,
        },
      };
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
      return {
        valid: false,
        error:
          requirement.description ||
          `当 ${formatCondition(requirement)} 时，必须提供 ${formatFieldList(missing)}`,
        issue: {
          code: 'conditional_required',
          fields: missing,
          description: requirement.description,
          condition: {
            field: requirement.when.field,
            equals: requirement.when.equals,
          },
        },
      };
    }
  }

  for (const fields of schema.atLeastOneOf ?? []) {
    if (fields.length === 0) continue;
    const satisfied = fields.some(
      (field) => field in data && !isMissingValue(data[field]),
    );
    if (!satisfied) {
      return {
        valid: false,
        error: `${formatFieldList(fields)} 至少提供一个`,
        issue: {
          code: 'at_least_one',
          fields,
        },
      };
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
    return {
      valid: false,
      error: `${formatFieldList(fields)} 必须同时提供或同时不提供；当前缺少 ${formatFieldList(missing)}`,
      issue: {
        code: 'all_or_none',
        fields: missing,
        groupFields: fields,
      },
    };
  }

  // 逐字段深度验证
  for (const [key, value] of Object.entries(data)) {
    const prop = properties[key];
    if (!prop) continue; // 未定义的字段直接透传，不报错

    // 类型校验
    const typeErr = checkType(value, prop, key);
    if (typeErr) {
      return {
        valid: false,
        error: typeErr,
        issue: {
          code: 'type',
          fields: [key],
        },
      };
    }

    // 枚举约束
    if (prop.enum !== undefined) {
      const enumStr = prop.enum.map((v) => JSON.stringify(v)).join(', ');
      if (!prop.enum.includes(value)) {
        return {
          valid: false,
          error: `参数 "${key}" 的值 ${JSON.stringify(value)} 不合法，允许值: [${enumStr}]`,
          issue: {
            code: 'enum',
            fields: [key],
          },
        };
      }
    }

    // 数值范围
    if (typeof value === 'number') {
      if (prop.minimum !== undefined && value < prop.minimum) {
        return {
          valid: false,
          error: `参数 "${key}" 不能小于 ${prop.minimum}，实际: ${value}`,
          issue: {
            code: 'minimum',
            fields: [key],
          },
        };
      }
      if (prop.maximum !== undefined && value > prop.maximum) {
        return {
          valid: false,
          error: `参数 "${key}" 不能大于 ${prop.maximum}，实际: ${value}`,
          issue: {
            code: 'maximum',
            fields: [key],
          },
        };
      }
    }

    // 数组约束
    if (Array.isArray(value)) {
      if (prop.minItems !== undefined && value.length < prop.minItems) {
        return {
          valid: false,
          error: `参数 "${key}" 数组长度不能少于 ${prop.minItems}，实际: ${value.length}`,
          issue: {
            code: 'min_items',
            fields: [key],
          },
        };
      }
      if (prop.maxItems !== undefined && value.length > prop.maxItems) {
        return {
          valid: false,
          error: `参数 "${key}" 数组长度不能超过 ${prop.maxItems}，实际: ${value.length}`,
          issue: {
            code: 'max_items',
            fields: [key],
          },
        };
      }
      // 数组元素枚举约束
      if (prop.items?.enum) {
        for (let i = 0; i < value.length; i++) {
          if (!prop.items.enum.includes(value[i])) {
            const enumStr = prop.items.enum
              .map((v) => JSON.stringify(v))
              .join(', ');
            return {
              valid: false,
              error: `参数 "${key}[${i}]" 的值 ${JSON.stringify(value[i])} 不合法，允许值: [${enumStr}]`,
              issue: {
                code: 'item_enum',
                fields: [`${key}[${i}]`],
              },
            };
          }
        }
      }
    }
  }

  return { valid: true, data };
}

/**
 * 将 SkillParametersSchema 转为 AI 可读的紧凑参数签名。
 * 用于 system prompt 中的 skill 索引条目，让 AI 无需 load_skill 也能知道参数结构。
 *
 * 示例输出:
 *   `time`(number,必填) `gender`(0|1,必填) `zaoWan`(boolean=false)
 */
export function formatParamSignature(schema: SkillParametersSchema): string {
  const required = new Set(schema.required ?? []);
  const base = Object.entries(schema.properties)
    .map(([key, prop]) => {
      const isRequired = required.has(key);
      let typeStr: string;

      if (prop.enum) {
        typeStr = prop.enum.map((v) => JSON.stringify(v)).join('|');
      } else if (prop.type === 'array') {
        const itemType = prop.items?.type ?? 'any';
        typeStr = `${itemType}[]`;
      } else if (Array.isArray(prop.type)) {
        typeStr = prop.type.join('|');
      } else {
        typeStr = prop.type;
      }

      if (isRequired) {
        return `\`${key}\`(${typeStr},必填)`;
      }
      const def =
        prop.default !== undefined ? `=${JSON.stringify(prop.default)}` : '';
      return `\`${key}\`(${typeStr}${def})`;
    })
    .join(' ');

  const ruleParts: string[] = [];
  for (const requirement of schema.conditionalRequired ?? []) {
    ruleParts.push(
      `${formatCondition(requirement)} => ${requirement.required.join(',')}`,
    );
  }
  for (const group of schema.atLeastOneOf ?? []) {
    ruleParts.push(`至少一项: ${group.join('|')}`);
  }
  for (const group of schema.allOrNoneOf ?? []) {
    ruleParts.push(`同时提供/同时不提供: ${group.join('&')}`);
  }

  if (ruleParts.length === 0) {
    return base;
  }

  return `${base} 条件: ${ruleParts.join('; ')}`.trim();
}
