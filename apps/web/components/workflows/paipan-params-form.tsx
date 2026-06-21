'use client';

import type {
  SkillParamPropertyDto,
  SkillParametersSchemaDto,
} from '@fateclaw/contracts/chat';

/**
 * 排盘节点的"参数默认值"表单 —— schema 驱动。
 *
 * 复用排盘目录(paipanApi.catalog)给出的 SkillParametersSchemaDto,按字段类型渲染:
 * 仅渲染顶层标量/枚举/布尔字段(起卦方式、是否包含某项等);数组/嵌套对象(多为运行时
 * 临时输入的卦数/时间)在搭建期不展开,运行时由 executeDirectPaipan 校验。命理类(八字/紫微)
 * 的生辰会在运行时按客户档案自动预填,这里设默认值即可。
 */

const inputClass =
  'w-full rounded-lg border border-hairline bg-canvas px-3 py-2 text-[13px] text-ink placeholder:text-muted focus:border-primary focus:outline-none';

type ParamKind = 'boolean' | 'enum' | 'number' | 'string' | 'unsupported';

/** 解析属性的主类型(type 可能是数组,取首个)。 */
function primaryType(prop: SkillParamPropertyDto): string {
  return Array.isArray(prop.type) ? (prop.type[0] ?? 'string') : prop.type;
}

/** 判断字段在搭建期表单里如何渲染。 */
function paramKind(prop: SkillParamPropertyDto): ParamKind {
  if (Array.isArray(prop.enum) && prop.enum.length > 0) return 'enum';
  const type = primaryType(prop);
  if (type === 'boolean') return 'boolean';
  if (type === 'number' || type === 'integer') return 'number';
  if (type === 'string') return 'string';
  return 'unsupported'; // array / object 等不在搭建期展开
}

export function PaipanParamsForm({
  schema,
  value,
  onChange,
  emptyHint,
}: {
  schema: SkillParametersSchemaDto | undefined;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  /** 无可配置字段时的提示文案。 */
  emptyHint: string;
}) {
  const setField = (key: string, next: unknown) => {
    const draft = { ...value };
    // 空值删键,保持默认参数最小化(运行时再由客户预填/默认补齐)。
    if (next === '' || next === undefined || next === null) {
      delete draft[key];
    } else {
      draft[key] = next;
    }
    onChange(draft);
  };

  const entries = schema ? Object.entries(schema.properties) : [];
  const fields = entries.filter(([, prop]) => paramKind(prop) !== 'unsupported');
  const requiredKeys = new Set(schema?.required ?? []);

  if (fields.length === 0) {
    return <p className="text-[12px] text-muted">{emptyHint}</p>;
  }

  return (
    <div className="space-y-3">
      {fields.map(([key, prop]) => {
        const kind = paramKind(prop);
        const required = requiredKeys.has(key);
        const raw = value[key];
        return (
          <label key={key} className="block space-y-1">
            {kind !== 'boolean' && (
              <span className="text-[12px] font-medium text-muted">
                {key}
                {required && <span className="text-error"> *</span>}
              </span>
            )}

            {kind === 'boolean' ? (
              <span className="flex cursor-pointer items-center gap-2 text-[12px] text-ink">
                <input
                  type="checkbox"
                  checked={Boolean(raw ?? prop.default ?? false)}
                  onChange={(event) => setField(key, event.target.checked)}
                  className="h-3.5 w-3.5 accent-[var(--primary)]"
                />
                {key}
                {prop.description ? `（${prop.description}）` : ''}
              </span>
            ) : kind === 'enum' ? (
              <select
                value={raw === undefined ? '' : String(raw)}
                onChange={(event) => setField(key, event.target.value)}
                className={inputClass}
              >
                <option value="">—</option>
                {(prop.enum ?? []).map((option) => (
                  <option key={String(option)} value={String(option)}>
                    {String(option)}
                  </option>
                ))}
              </select>
            ) : kind === 'number' ? (
              <input
                type="number"
                value={raw === undefined ? '' : String(raw)}
                min={prop.minimum}
                max={prop.maximum}
                placeholder={
                  prop.default !== undefined ? String(prop.default) : ''
                }
                onChange={(event) => {
                  const text = event.target.value;
                  setField(key, text === '' ? '' : Number(text));
                }}
                className={inputClass}
              />
            ) : (
              <input
                type="text"
                value={raw === undefined ? '' : String(raw)}
                placeholder={
                  prop.default !== undefined ? String(prop.default) : ''
                }
                onChange={(event) => setField(key, event.target.value)}
                className={inputClass}
              />
            )}

            {kind !== 'boolean' && prop.description && (
              <span className="block text-[11px] text-muted/80">
                {prop.description}
              </span>
            )}
          </label>
        );
      })}
    </div>
  );
}
