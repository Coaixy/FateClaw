import type { ToolDefinition } from './types.js';

export interface OpenAIStrictParams {
  [key: string]: unknown;
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
}

/**
 * 将标准 ToolDefinition schema 转为 OpenAI strict function calling 格式：
 * - 所有 properties 加入 required
 * - 原可选字段的 type 变为 nullable
 * - 顶层和嵌套 object 加 additionalProperties: false
 */
export function toOpenAIStrictParameters(
  params: ToolDefinition['function']['parameters'],
): OpenAIStrictParams {
  const requiredSet = new Set(params.required ?? []);
  const allKeys = Object.keys(params.properties);

  const strictProps: Record<string, unknown> = {};
  for (const key of allKeys) {
    const prop = params.properties[key] as Record<string, unknown>;
    strictProps[key] = requiredSet.has(key)
      ? deepStrictify(prop)
      : makeNullable(deepStrictify(prop));
  }

  return {
    type: 'object',
    properties: strictProps,
    required: allKeys,
    additionalProperties: false,
  };
}

function deepStrictify(prop: Record<string, unknown>): Record<string, unknown> {
  if (prop.type === 'object' && prop.properties) {
    return {
      ...prop,
      ...toOpenAIStrictParameters(
        prop as ToolDefinition['function']['parameters'],
      ),
    };
  }
  if (prop.type === 'array' && prop.items && typeof prop.items === 'object') {
    return {
      ...prop,
      items: deepStrictify(prop.items as Record<string, unknown>),
    };
  }
  return prop;
}

function makeNullable(prop: Record<string, unknown>): Record<string, unknown> {
  if (prop.enum) {
    const { enum: _enumRemoved, ...rest } = prop;
    return {
      anyOf: [
        { ...rest, enum: prop.enum },
        { type: 'null' },
      ],
    };
  }

  const currentType = prop.type;
  if (Array.isArray(currentType)) {
    return currentType.includes('null')
      ? prop
      : { ...prop, type: [...currentType, 'null'] };
  }
  if (typeof currentType === 'string') {
    return { ...prop, type: [currentType, 'null'] };
  }
  return prop;
}
