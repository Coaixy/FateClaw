/**
 * 对外开放 API 的命名风格转换：对外 snake_case ↔ 内部 camelCase。
 *
 * @remarks
 * 排盘 registry 的参数 schema 与校验用 camelCase（如 solarDate / zishiMode），但对外契约
 * 约定 snake_case（设计文档 §2.3）。故在 /api/v1/paipan 边界做转换：请求体 snake→camel 后喂给
 * 校验，catalog 输出的 schema camel→snake 后对外展示，保证「对外只见 snake_case」。
 */

import type { SkillParametersSchemaDto } from '@fateclaw/contracts/chat';

/** snake_case → camelCase（单个 key）。 */
function toCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** camelCase → snake_case（单个 key）。 */
function toSnake(key: string): string {
  return key.replace(/([A-Z])/g, (c) => `_${c.toLowerCase()}`);
}

/** 递归把对象 key 由 snake_case 转 camelCase（数组递归元素，标量原样）。 */
export function snakeToCamelKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeToCamelKeysDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[toCamel(k)] = snakeToCamelKeysDeep(v);
    }
    return out;
  }
  return value;
}

/** 递归把对象 key 由 camelCase 转 snake_case（数组递归元素，标量原样）。 */
function camelToSnakeKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelToSnakeKeysDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[toSnake(k)] = camelToSnakeKeysDeep(v);
    }
    return out;
  }
  return value;
}

/**
 * 把排盘参数 schema 转为对外 snake_case 展示。
 *
 * @param schema registry 的 camelCase 参数 schema。
 * @returns 字段名全部 snake_case 的等价 schema。
 * @remarks
 * 字段名在 schema 中既是 properties 的 key，也作为 required / atLeastOneOf / allOrNoneOf /
 * conditionalRequired 里的「值」。camelToSnakeKeysDeep 只转 key，故这里额外把这些「字段名作为
 * 值」的位置也转 snake_case。嵌套 object 属性的 required（如紫微 horoscope.required=['date']）
 * 字段名均为无需转换的单词，故只修正顶层约束即可覆盖现有 7 种排盘。
 */
export function paipanSchemaToSnakeCase(
  schema: SkillParametersSchemaDto | undefined,
): unknown {
  if (!schema || typeof schema !== 'object') return schema;
  const base = camelToSnakeKeysDeep(schema) as Record<string, unknown>;

  if (Array.isArray(base.required)) {
    base.required = (base.required as string[]).map(toSnake);
  }
  for (const groupKey of ['at_least_one_of', 'all_or_none_of']) {
    const group = base[groupKey];
    if (Array.isArray(group)) {
      base[groupKey] = (group as string[][]).map((arr) => arr.map(toSnake));
    }
  }
  const conditional = base.conditional_required;
  if (Array.isArray(conditional)) {
    base.conditional_required = conditional.map((entry) => {
      const e = entry as Record<string, unknown>;
      const when = e.when as { field?: unknown } | undefined;
      return {
        ...e,
        when:
          when && typeof when.field === 'string'
            ? { ...when, field: toSnake(when.field) }
            : when,
        required: Array.isArray(e.required)
          ? (e.required as string[]).map(toSnake)
          : e.required,
      };
    });
  }
  return base;
}
