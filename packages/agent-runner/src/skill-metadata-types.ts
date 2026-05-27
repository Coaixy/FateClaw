export type SkillParamType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'array'
  | 'object';

/** 单个参数的属性定义（JSON Schema 子集）。 */
export interface SkillParamProperty {
  type: SkillParamType | SkillParamType[];
  description: string;
  /** 参数缺失时自动填充的默认值。 */
  default?: unknown;
  /** 枚举值约束。 */
  enum?: unknown[];
  /** 数值下限（含）。 */
  minimum?: number;
  /** 数值上限（含）。 */
  maximum?: number;
  /** 数组最小长度。 */
  minItems?: number;
  /** 数组最大长度。 */
  maxItems?: number;
  /** 数组元素类型约束。 */
  items?: { type: string; enum?: unknown[] };
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

/** Skill stdin 参数 Schema（JSON Schema object 子集）。 */
export interface SkillParametersSchema {
  type: 'object';
  properties: Record<string, SkillParamProperty>;
  required?: string[];
  conditionalRequired?: SkillConditionalRequirement[];
  atLeastOneOf?: string[][];
  /** 成组字段：组内字段必须同时提供或同时不提供。 */
  allOrNoneOf?: string[][];
  examples?: SkillExamplePayload[];
}

export interface SkillMetadata {
  dir: string;
  name: string;
  description: string;
  trigger: string;
  /** stdin 参数 Schema，用于执行前验证和 AI 提示生成。 */
  parameters?: SkillParametersSchema;
  /** Skill 类型：official = 官方（默认），user = 用户自定义知识 Skill */
  type?: 'official' | 'user';
  /** 用户 Skill 来源：self = 自建，subscribed = 订阅他人 */
  source?: 'self' | 'subscribed';
  /** 用户 Skill 的类别（知识类别，如 '通用'、'八字'） */
  category?: string;
  /** 用户 Skill 的路由模式 */
  usageMode?: 'force_injected' | 'reference_only';
}
