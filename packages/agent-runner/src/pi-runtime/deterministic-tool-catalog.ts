import type { SkillParametersSchema } from '../skill-metadata-types.js';
import type { ToolDefinition, ToolExecutionMode } from '../types.js';

export interface PiDeterministicScriptToolSpec {
  toolName: string;
  skillName: string;
  displayName: string;
  description: string;
  script: string;
  executionMode: ToolExecutionMode;
  parameters: SkillParametersSchema;
}

const ichingLikeParameters: SkillParametersSchema = {
  type: 'object',
  properties: {
    method: {
      type: 'string',
      description: '起卦方式',
      enum: ['dayan', 'lueshifa', 'manual', 'three', 'array', 'time'],
      default: 'dayan',
    },
    yao: {
      type: 'string',
      description:
        'method=manual 时必填：6 位爻字符串，每位取值 6/7/8/9，从初爻到上爻。',
    },
    numbers: {
      type: 'array',
      description: 'method=three 时长度必须为 3；method=array 时长度 >= 2',
      items: { type: 'integer' },
    },
    datetime: {
      type: 'string',
      description: '排盘时间，格式 YYYY-MM-DD HH:mm，默认当前时间',
    },
    question: {
      type: 'string',
      description: '可选：问卜主题（原样回传，不参与排盘计算）',
    },
  },
};

export const PI_DETERMINISTIC_SCRIPT_TOOLS: PiDeterministicScriptToolSpec[] = [
  {
    toolName: 'bazi_paipan',
    skillName: 'bazi-paipan',
    displayName: '八字排盘',
    description: '八字排盘：四柱、大运、完整流年、格局，基于本地确定性算法计算。',
    script: 'paipan.js',
    executionMode: 'serial',
    parameters: {
      type: 'object',
      properties: {
        solarDate: {
          type: 'string',
          description: '阳历出生日期 YYYY-MM-DD',
        },
        hour: {
          type: 'integer',
          description: '出生小时 0-23（24 小时制）',
          minimum: 0,
          maximum: 23,
        },
        minute: {
          type: 'integer',
          description: '出生分钟 0-59',
          minimum: 0,
          maximum: 59,
          default: 0,
        },
        gender: {
          type: 'string',
          description: '性别',
          enum: ['男', '女', 'male', 'female'],
        },
        zishiMode: {
          type: 'string',
          description: '子时切换：early=23:00~00:00 算次日；late=算当日',
          enum: ['early', 'late'],
          default: 'early',
        },
        childLimitMode: {
          type: 'string',
          description: '起运算法',
          enum: ['default', 'china95', 'lunar_sect1', 'lunar_sect2'],
          default: 'default',
        },
        include: {
          type: 'array',
          description: '要返回的部分，默认全部',
          items: { type: 'string', enum: ['bazi', 'fortune', 'pattern'] },
        },
      },
      required: ['solarDate', 'hour', 'gender'],
    },
  },
  {
    toolName: 'iching_paipan',
    skillName: 'iching-paipan',
    displayName: '六爻排盘',
    description: '六爻纳甲排盘：返回本卦、变卦、六亲、六兽、世应、伏神等确定性数据。',
    script: 'paipan.js',
    executionMode: 'serial',
    parameters: ichingLikeParameters,
  },
  {
    toolName: 'jingzhan_paipan',
    skillName: 'jingzhan-paipan',
    displayName: '经占排盘',
    description: '周易经占排盘：按大衍筮法 / 略筮法生成卦象与取辞数据。',
    script: 'paipan.js',
    executionMode: 'serial',
    parameters: ichingLikeParameters,
  },
  {
    toolName: 'qimen_paipan',
    skillName: 'qimen-paipan',
    displayName: '奇门遁甲排盘',
    description: '奇门遁甲排盘：返回排局、值符值使、天地盘、八门九星八神等确定性数据。',
    script: 'paipan.js',
    executionMode: 'serial',
    parameters: {
      type: 'object',
      properties: {
        solarDate: {
          type: 'string',
          description: '阳历日期 YYYY-MM-DD。不传则用当前时间',
        },
        hour: {
          type: 'integer',
          description: '小时 0-23（24 小时制）。不传则用当前时间',
          minimum: 0,
          maximum: 23,
        },
        minute: {
          type: 'integer',
          description: '分钟 0-59；与 solarDate/hour 一起传时默认 0',
          minimum: 0,
          maximum: 59,
          default: 0,
        },
      },
      allOrNoneOf: [['solarDate', 'hour']],
    },
  },
  {
    toolName: 'ziwei_paipan',
    skillName: 'ziwei-paipan',
    displayName: '紫微斗数排盘',
    description: '紫微斗数排盘：根据阳历出生时间和性别生成十二宫星盘。',
    script: 'paipan.js',
    executionMode: 'serial',
    parameters: {
      type: 'object',
      properties: {
        solarDate: {
          type: 'string',
          description: '阳历出生日期 YYYY-MM-DD',
        },
        hour: {
          type: 'integer',
          description: '出生小时 0-23（24 小时制）',
          minimum: 0,
          maximum: 23,
        },
        minute: {
          type: 'integer',
          description: '出生分钟 0-59，用于判断早晚子时边界',
          minimum: 0,
          maximum: 59,
          default: 0,
        },
        gender: {
          type: 'string',
          description: '性别，male 或 female（也接受 男/女）',
          enum: ['male', 'female', '男', '女'],
        },
        fixLeap: {
          type: 'boolean',
          description: '是否修正闰月：前半月作上月，后半月作下月',
          default: true,
        },
        horoscope: {
          type: 'object',
          description: '可选：叠加运盘（大限/小限/流年/流月/流日/流时）',
        },
      },
      required: ['solarDate', 'hour', 'gender'],
    },
  },
];

export function getPiDeterministicScriptTools(
  enabledSkillNames: readonly string[] | undefined,
): PiDeterministicScriptToolSpec[] {
  if (!enabledSkillNames) return [];
  const enabled = new Set(enabledSkillNames);
  return PI_DETERMINISTIC_SCRIPT_TOOLS.filter((tool) =>
    enabled.has(tool.displayName) || enabled.has(tool.skillName),
  );
}

export function toToolDefinition(
  spec: PiDeterministicScriptToolSpec,
): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: spec.toolName,
      description: spec.description,
      parameters: spec.parameters,
    },
  };
}
