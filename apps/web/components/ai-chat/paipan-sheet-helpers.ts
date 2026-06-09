import type { PaipanFlowHelpers } from '@/components/ai-chat/paipan-flows';
import type { PaipanSchema } from '@/features/paipan/api';

type ParamProperty = NonNullable<PaipanSchema['properties']>[string];

type FieldCopy = {
  label: string;
  description?: string;
  placeholder?: string;
  optionLabels?: Record<string, string>;
};

const FRIENDLY_FIELD_COPY: Record<string, FieldCopy> = {
  zishiMode: {
    label: '子时换日规则',
    description: '如果出生在 23:00 到 00:59，可在这里切换采用哪一种排法。',
    optionLabels: {
      early: '子时按次日',
      late: '子时按当日',
    },
  },
  childLimitMode: {
    label: '起运算法',
    description: '通常保持默认即可，只有明确知道流派差异时再修改。',
    optionLabels: {
      default: '常用默认',
      china95: '中国历法 95',
      lunar_sect1: '农历流派一',
      lunar_sect2: '农历流派二',
    },
  },
  include: {
    label: '盘面内容',
    description: '默认会返回完整内容，一般不用改。',
    optionLabels: {
      bazi: '八字四柱',
      fortune: '大运流年',
      pattern: '格局',
    },
  },
  fixLeap: {
    label: '闰月修正',
    description: '紫微斗数里遇到闰月时的处理方式，通常保持默认开启即可。',
  },
  dayDivide: {
    label: '晚子时换日规则',
    description: '紫微斗数里 23:00-23:59 的晚子时处理方式。',
    optionLabels: {
      forward: '晚子时算次日',
      current: '晚子时算当日',
    },
  },
  yearDivide: {
    label: '年干支分界',
    description: '影响年干支、生肖以及部分按年份安置的星曜。',
    optionLabels: {
      normal: '农历新年分界',
      exact: '立春分界',
    },
  },
  horoscopeDivide: {
    label: '运限分界',
    description: '影响大限、流年等运盘分界规则。',
    optionLabels: {
      normal: '农历新年分界',
      exact: '立春分界',
    },
  },
  ageDivide: {
    label: '小限分界',
    description: '影响小限按自然年还是生日切换。',
    optionLabels: {
      normal: '自然年分界',
      birthday: '生日分界',
    },
  },
  horoscope: {
    label: '叠加运盘',
    description: '想同时看大限、流年、流月等运盘时再展开填写。',
  },
  'horoscope.date': {
    label: '运盘目标日期（公历）',
    placeholder: 'YYYY-MM-DD',
  },
  'horoscope.scopes': {
    label: '运盘范围',
    optionLabels: {
      decadal: '大限',
      age: '小限',
      yearly: '流年',
      monthly: '流月',
      daily: '流日',
      hourly: '流时',
    },
  },
  method: {
    label: '起卦方式',
    optionLabels: {
      dayan: '大衍筮法',
      lueshifa: '略筮法',
      manual: '手动输入六爻',
      three: '三数起卦',
      array: '数字起卦',
      time: '时间起卦（公历）',
      counts: '数值起卦',
      trigrams: '指定上下卦',
    },
  },
  countMethod: {
    label: '取数来源',
    optionLabels: {
      number: '报数',
      word: '字数',
      sound: '声音',
      object: '物数',
      direction: '方位',
      external: '外应',
    },
  },
  upper: {
    label: '上卦取数',
  },
  lower: {
    label: '下卦取数',
  },
  moving: {
    label: '动爻取数',
    description: '不填写时使用上卦取数和下卦取数之和。',
  },
  upperTrigram: {
    label: '上卦',
  },
  lowerTrigram: {
    label: '下卦',
  },
  movingLine: {
    label: '动爻',
  },
  label: {
    label: '备注',
  },
  datetime: {
    label: '起卦时间（公历）',
    placeholder: 'YYYY-MM-DD HH:mm',
  },
  solarDate: {
    label: '日期（公历）',
    placeholder: 'YYYY-MM-DD',
  },
  hour: {
    label: '小时（公历时间）',
  },
  minute: {
    label: '分钟（公历时间）',
  },
  randomNumber: {
    label: '随机数字',
    description: '用于随机时辰；同一个数字会稳定映射到同一个时辰。',
    placeholder: '例如 8848',
  },
  yao: {
    label: '六爻卦象',
    description: '从下往上输入 6 位数字，每位只能是 6、7、8、9。',
    placeholder: '例如 789678',
  },
  numbers: {
    label: '数字',
    description: '多个数字用逗号分隔，例如 3, 8, 5。',
    placeholder: '例如 3, 8, 5',
  },
};

function buildDefaultValuesFromSchema(
  schema?: PaipanSchema,
): Record<string, unknown> {
  if (!schema) return {};
  const result: Record<string, unknown> = {};
  for (const [key, property] of Object.entries(schema.properties)) {
    if (property.default !== undefined) {
      result[key] = structuredClone(property.default);
      continue;
    }
    if (property.type === 'object' && property.properties) {
      const nestedDefaults = buildDefaultValuesFromSchema({
        type: 'object',
        properties: property.properties,
        required: property.required,
      });
      if (Object.keys(nestedDefaults).length > 0) {
        result[key] = nestedDefaults;
      }
    }
  }
  return result;
}

function getValueAtPath(
  source: Record<string, unknown>,
  path: string[],
): unknown {
  let current: unknown = source;
  for (const segment of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function setValueAtPath(
  source: Record<string, unknown>,
  path: string[],
  value: unknown,
): Record<string, unknown> {
  const next: Record<string, unknown> = structuredClone(source);
  let current: Record<string, unknown> = next;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    const existing = current[segment];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }

  const leafKey = path[path.length - 1];
  if (value === undefined) {
    delete current[leafKey];
  } else {
    current[leafKey] = value;
  }
  return pruneEmptyObjects(next);
}

function pruneEmptyObjects(value: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined) {
      continue;
    }
    if (Array.isArray(raw)) {
      next[key] = raw;
      continue;
    }
    if (raw && typeof raw === 'object') {
      const pruned = pruneEmptyObjects(raw as Record<string, unknown>);
      if (Object.keys(pruned).length > 0) {
        next[key] = pruned;
      }
      continue;
    }
    next[key] = raw;
  }
  return next;
}

function stripPrivateFields(value: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key.startsWith('$')) {
      continue;
    }
    if (Array.isArray(raw)) {
      next[key] = raw;
      continue;
    }
    if (raw && typeof raw === 'object') {
      next[key] = stripPrivateFields(raw as Record<string, unknown>);
      continue;
    }
    next[key] = raw;
  }
  return next;
}

function parseDelimitedArrayInput(
  raw: string,
  itemType: ParamProperty['items'] extends { type: infer T } ? T : string,
): unknown[] | undefined {
  const normalized = raw
    .split(/[\n,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (normalized.length === 0) {
    return undefined;
  }
  if (itemType === 'integer' || itemType === 'number') {
    return normalized.map((item) =>
      itemType === 'integer' ? Number.parseInt(item, 10) : Number(item),
    );
  }
  return normalized;
}

function formatArrayInputValue(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.join(', ');
}

function getPrimaryType(property: ParamProperty): string {
  return Array.isArray(property.type) ? property.type[0] : property.type;
}

function normalizeGenderValue(value: unknown): '男' | '女' | undefined {
  if (value === '男' || value === 'male') return '男';
  if (value === '女' || value === 'female') return '女';
  return undefined;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function getCurrentLocalDateParts() {
  const now = new Date();
  return {
    date: `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`,
    hour: now.getHours(),
    minute: now.getMinutes(),
    dateTime: `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}T${pad2(now.getHours())}:${pad2(now.getMinutes())}`,
  };
}

function parseTimeValue(raw: string): { hour?: number; minute?: number } {
  if (!raw) return {};
  const [hourRaw, minuteRaw] = raw.split(':');
  const hour = Number.parseInt(hourRaw ?? '', 10);
  const minute = Number.parseInt(minuteRaw ?? '', 10);
  if (Number.isNaN(hour) || Number.isNaN(minute)) {
    return {};
  }
  return { hour, minute };
}

function fromDateTimeLocalValue(value: string): string | undefined {
  return value.trim() ? value.replace('T', ' ') : undefined;
}

function isValidInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function parseDateValue(value: unknown): { year: number; month: number; day: number } | null {
  if (typeof value !== 'string') return null;
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!matched) return null;
  const year = Number.parseInt(matched[1], 10);
  const month = Number.parseInt(matched[2], 10);
  const day = Number.parseInt(matched[3], 10);
  if (!year || month < 1 || month > 12) return null;
  const maxDay = getDaysInMonth(year, month);
  if (day < 1 || day > maxDay) return null;
  return { year, month, day };
}

function buildDateValue(year: number, month: number, day: number): string {
  const safeMonth = clampNumber(month, 1, 12);
  const safeDay = clampNumber(day, 1, getDaysInMonth(year, safeMonth));
  return `${year}-${pad2(safeMonth)}-${pad2(safeDay)}`;
}

function parseDateTimePickerValue(value: unknown): {
  date?: string;
  hour?: number;
  minute?: number;
} {
  if (typeof value !== 'string' || !value.trim()) return {};
  const [dateRaw, timeRaw] = value.replace('T', ' ').split(' ');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRaw ?? '')) return {};
  const time = parseTimeValue(timeRaw ?? '');
  return { date: dateRaw, hour: time.hour, minute: time.minute };
}

function buildDateTimePickerValue(next: {
  date?: string;
  hour?: number;
  minute?: number;
}): string | undefined {
  if (!next.date || typeof next.hour !== 'number' || Number.isNaN(next.hour)) {
    return undefined;
  }
  return `${next.date} ${pad2(next.hour)}:${pad2(next.minute ?? 0)}`;
}

function getFieldCopy(fieldPathKey: string, fallbackLabel: string, fallbackDescription?: string): FieldCopy {
  return FRIENDLY_FIELD_COPY[fieldPathKey] ?? {
    label: fallbackLabel,
    description: fallbackDescription,
  };
}

function getOptionLabel(fieldPathKey: string, option: unknown): string {
  const value = String(option);
  return FRIENDLY_FIELD_COPY[fieldPathKey]?.optionLabels?.[value] ?? value;
}

function buildInitialDraftForSkill(
  skillDir: string,
  schema?: PaipanSchema,
): Record<string, unknown> {
  const base = buildDefaultValuesFromSchema(schema);

  if (skillDir === 'qimen-paipan' || skillDir === 'liuren-paipan') {
    return { $useCurrentTime: true };
  }

  if (skillDir === 'bazi-paipan' || skillDir === 'ziwei-paipan') {
    return {
      ...base,
      minute:
        typeof base.minute === 'number' && !Number.isNaN(base.minute)
          ? base.minute
          : 0,
      gender: normalizeGenderValue(base.gender),
    };
  }

  if (skillDir === 'iching-paipan' || skillDir === 'jingzhan-paipan') {
    const hasPresetDatetime =
      typeof base.datetime === 'string' && base.datetime.trim().length > 0;
    return {
      ...base,
      method: typeof base.method === 'string' ? base.method : 'dayan',
      $useCurrentTime: !hasPresetDatetime,
      datetime: hasPresetDatetime ? base.datetime : undefined,
    };
  }

  if (skillDir === 'meihua-paipan') {
    const hasPresetDatetime =
      typeof base.datetime === 'string' && base.datetime.trim().length > 0;
    return {
      ...base,
      method: typeof base.method === 'string' ? base.method : 'time',
      countMethod:
        typeof base.countMethod === 'string' ? base.countMethod : 'number',
      $useCurrentTime: !hasPresetDatetime,
      datetime: hasPresetDatetime ? base.datetime : undefined,
    };
  }

  return { ...base };
}

function buildSubmitInputForSkill(
  skillDir: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  // 这里先剥离纯前端辅助字段，再按术数规则裁掉当前模式下无效的参数。
  const normalized = pruneEmptyObjects(stripPrivateFields(input));

  if (skillDir === 'qimen-paipan' || skillDir === 'liuren-paipan') {
    const useCurrentTime = getValueAtPath(input, ['$useCurrentTime']) !== false;
    if (useCurrentTime) {
      return {};
    }
    if (skillDir === 'liuren-paipan') {
      const timeMode = getValueAtPath(input, ['$liurenTimeMode']);
      if (typeof timeMode === 'string') {
        normalized.timeMode = timeMode;
      }
    }
    return normalized;
  }

  if (skillDir === 'iching-paipan' || skillDir === 'jingzhan-paipan') {
    const method = typeof normalized.method === 'string' ? normalized.method : 'dayan';
    const useCurrentTime = getValueAtPath(input, ['$useCurrentTime']) !== false;
    if (method !== 'manual') {
      delete normalized.yao;
    }
    if (method !== 'three' && method !== 'array') {
      delete normalized.numbers;
    }
    if (useCurrentTime) {
      delete normalized.datetime;
    }
    return normalized;
  }

  if (skillDir === 'meihua-paipan') {
    const method =
      typeof normalized.method === 'string' ? normalized.method : 'time';
    const useCurrentTime = getValueAtPath(input, ['$useCurrentTime']) !== false;
    if (method !== 'time' || useCurrentTime) {
      delete normalized.datetime;
    }
    if (method !== 'counts') {
      delete normalized.countMethod;
      delete normalized.upper;
      delete normalized.lower;
      delete normalized.moving;
    }
    if (method !== 'trigrams') {
      delete normalized.upperTrigram;
      delete normalized.lowerTrigram;
      delete normalized.movingLine;
    }
    if (method === 'time') {
      delete normalized.label;
    }
    return normalized;
  }

  return normalized;
}

function validateDraftForSkill(
  skillDir: string,
  draft: Record<string, unknown>,
): string | null {
  if (skillDir === 'bazi-paipan' || skillDir === 'ziwei-paipan') {
    if (typeof getValueAtPath(draft, ['solarDate']) !== 'string') {
      return '请先选择出生日期（公历）';
    }
    if (typeof getValueAtPath(draft, ['hour']) !== 'number') {
      return '请先选择出生时间（公历）';
    }
    if (!normalizeGenderValue(getValueAtPath(draft, ['gender']))) {
      return '请先选择性别';
    }
    return null;
  }

  if (skillDir === 'qimen-paipan' || skillDir === 'liuren-paipan') {
    const useCurrentTime = getValueAtPath(draft, ['$useCurrentTime']) !== false;
    if (useCurrentTime) {
      return null;
    }
    if (typeof getValueAtPath(draft, ['solarDate']) !== 'string') {
      return skillDir === 'liuren-paipan'
        ? '请先选择起课日期（公历）'
        : '请先选择起盘日期（公历）';
    }
    if (typeof getValueAtPath(draft, ['hour']) !== 'number') {
      return skillDir === 'liuren-paipan'
        ? '请先选择起课时间（公历）'
        : '请先选择起盘时间（公历）';
    }
    return null;
  }

  if (skillDir === 'iching-paipan' || skillDir === 'jingzhan-paipan') {
    const method = typeof getValueAtPath(draft, ['method']) === 'string'
      ? String(getValueAtPath(draft, ['method']))
      : 'dayan';
    const useCurrentTime = getValueAtPath(draft, ['$useCurrentTime']) !== false;
    const yao = typeof getValueAtPath(draft, ['yao']) === 'string'
      ? String(getValueAtPath(draft, ['yao'])).trim()
      : '';
    const numbers = getValueAtPath(draft, ['numbers']);
    const datetime = typeof getValueAtPath(draft, ['datetime']) === 'string'
      ? String(getValueAtPath(draft, ['datetime'])).trim()
      : '';

    if (!useCurrentTime && !datetime) {
      return '请先选择起卦时间（公历）';
    }

    if (method === 'manual' && !/^[6789]{6}$/.test(yao)) {
      return '手动起卦需要输入 6 位爻值，例如 789678';
    }

    if (method === 'three') {
      if (
        !Array.isArray(numbers) ||
        numbers.length !== 3 ||
        numbers.some((value) => typeof value !== 'number' || Number.isNaN(value))
      ) {
        return '三数起卦需要输入 3 个数字，例如 3, 8, 5';
      }
    }

    if (method === 'array') {
      if (
        !Array.isArray(numbers) ||
        numbers.length < 2 ||
        numbers.some((value) => typeof value !== 'number' || Number.isNaN(value))
      ) {
        return '数字起卦至少需要输入 2 个数字';
      }
    }
  }

  if (skillDir === 'meihua-paipan') {
    const method =
      typeof getValueAtPath(draft, ['method']) === 'string'
        ? String(getValueAtPath(draft, ['method']))
        : 'time';
    const useCurrentTime = getValueAtPath(draft, ['$useCurrentTime']) !== false;
    const datetime =
      typeof getValueAtPath(draft, ['datetime']) === 'string'
        ? String(getValueAtPath(draft, ['datetime'])).trim()
        : '';
    const upper = getValueAtPath(draft, ['upper']);
    const lower = getValueAtPath(draft, ['lower']);
    const moving = getValueAtPath(draft, ['moving']);
    const upperTrigram = getValueAtPath(draft, ['upperTrigram']);
    const lowerTrigram = getValueAtPath(draft, ['lowerTrigram']);
    const movingLine = getValueAtPath(draft, ['movingLine']);

    if (method === 'time') {
      if (!useCurrentTime && !datetime) {
        return '请先选择起卦时间（公历）';
      }
      return null;
    }

    if (method === 'counts') {
      if (typeof upper !== 'number' || !Number.isInteger(upper)) {
        return '请先填写上卦取数';
      }
      if (typeof lower !== 'number' || !Number.isInteger(lower)) {
        return '请先填写下卦取数';
      }
      if (
        moving !== undefined &&
        (typeof moving !== 'number' || !Number.isInteger(moving))
      ) {
        return '动爻取数需要填写整数';
      }
      return null;
    }

    if (method === 'trigrams') {
      if (typeof upperTrigram !== 'string') {
        return '请先选择上卦';
      }
      if (typeof lowerTrigram !== 'string') {
        return '请先选择下卦';
      }
      if (
        typeof movingLine !== 'number' ||
        !Number.isInteger(movingLine) ||
        movingLine < 1 ||
        movingLine > 6
      ) {
        return '请先选择动爻';
      }
      return null;
    }
  }

  return null;
}

function getSimpleHiddenFieldPaths(skillDir: string): string[] {
  switch (skillDir) {
    case 'bazi-paipan':
    case 'ziwei-paipan':
      return ['solarDate', 'hour', 'minute', 'gender'];
    case 'qimen-paipan':
    case 'liuren-paipan':
      return ['solarDate', 'hour', 'minute', 'randomNumber', 'timeMode'];
    case 'iching-paipan':
    case 'jingzhan-paipan':
      return ['method', 'datetime', 'yao', 'numbers'];
    case 'meihua-paipan':
      return [
        'method',
        'datetime',
        'countMethod',
        'upper',
        'lower',
        'moving',
        'upperTrigram',
        'lowerTrigram',
        'movingLine',
        'label',
      ];
    default:
      return [];
  }
}

function hasVisibleSchemaFields(
  schema: PaipanSchema | undefined,
  hiddenPaths: Set<string>,
  pathPrefix: string[] = [],
): boolean {
  if (!schema) return false;

  return Object.entries(schema.properties).some(([key, property]) => {
    const path = [...pathPrefix, key];
    const fieldPathKey = path.join('.');

    if (hiddenPaths.has(fieldPathKey)) {
      return false;
    }

    const type = getPrimaryType(property);
    if (type === 'object' && property.properties) {
      return hasVisibleSchemaFields(
        {
          type: 'object',
          properties: property.properties,
          required: property.required,
        },
        hiddenPaths,
        path,
      );
    }

    return true;
  });
}

/**
 * 引导式排盘 flow 复用的纯数据辅助函数。
 *
 * 这些函数保持和旧弹层一致，避免不同 flow 产生提交格式差异。
 */
export const PAIPAN_FLOW_HELPERS: PaipanFlowHelpers = {
  getValueAtPath,
  normalizeGenderValue,
  getCurrentLocalDateParts,
  fromDateTimeLocalValue,
  formatArrayInputValue,
  parseDelimitedArrayInput,
};

/**
 * `PaipanSheet` UI 内部复用的纯函数集合。
 *
 * 通过对象导出让 helper 文件内部函数保持私有，减少拆分后的公共 API 面。
 */
export const PAIPAN_SHEET_HELPERS = {
  buildDateTimePickerValue,
  buildDateValue,
  buildInitialDraftForSkill,
  buildSubmitInputForSkill,
  clampNumber,
  formatArrayInputValue,
  getCurrentLocalDateParts,
  getDaysInMonth,
  getFieldCopy,
  getOptionLabel,
  getPrimaryType,
  getSimpleHiddenFieldPaths,
  getValueAtPath,
  hasVisibleSchemaFields,
  isValidInteger,
  pad2,
  parseDateTimePickerValue,
  parseDateValue,
  parseDelimitedArrayInput,
  setValueAtPath,
  validateDraftForSkill,
} as const;
