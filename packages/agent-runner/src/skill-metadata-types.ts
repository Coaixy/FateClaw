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

export interface SkillManifest {
  /** manifest 版本号。当前统一结构版本为 2。 */
  manifestVersion?: number;
  name?: string;
  description?: string;
  trigger?: string;
  /** Pi Runtime 直接暴露工具或 Skill 资源。 */
  requiresLoad?: boolean;
  /** 唯一公开入口。 */
  entry?: SkillEntry;
  parameters?: SkillParametersSchema;
}

export interface SkillMetadata {
  dir: string;
  name: string;
  description: string;
  trigger: string;
  entry?: SkillEntry;
  /** stdin 参数 Schema，用于执行前验证和 AI 提示生成。 */
  parameters?: SkillParametersSchema;
  /** Skill 类型：official = 官方（默认），user = 用户自定义知识 Skill */
  type?: 'official' | 'user';
  /** Skill 元数据来源。 */
  manifestSource?: 'SKILL.md' | 'user-skill';
  /** 保留给历史 DTO 的版本字段；Pi 文本 Skill 不使用它作为运行时真源。 */
  manifestVersion?: number;
  /** Pi Runtime 直接暴露工具或 Skill 资源。 */
  requiresLoad?: boolean;
  /** 用户 Skill 来源：self = 自建，subscribed = 订阅他人 */
  source?: 'self' | 'subscribed';
  /** 用户 Skill 的类别（知识类别，如 '通用'、'八字'） */
  category?: string;
  /** 用户 Skill 的路由模式 */
  usageMode?: 'force_injected' | 'reference_only';
}

export interface SkillRuntimePayload {
  protocol_version: 1;
  skill_name: string;
  display_name: string;
  requires_load: boolean;
  manifest_source: 'SKILL.md' | 'user-skill';
  entry?: SkillEntry;
  parameter_signature?: string;
  parameters_schema?: SkillParametersSchema;
}

export interface SkillRuntimeGuidancePayload {
  protocol_version: 1;
  skill_name: string;
  recommended_entry:
    | { type: 'script'; file: string }
    | { type: 'tool'; tool: string; fallbackScript?: string }
    | { type: 'knowledge_only' };
  notes: string[];
}
