import { runBaziPaipan } from './paipan-runners/bazi.js';
import { runIchingPaipan } from './paipan-runners/iching.js';
import { runJingzhanPaipan } from './paipan-runners/jingzhan.js';
import { runLiurenPaipan } from './paipan-runners/liuren.js';
import { runQimenPaipan } from './paipan-runners/qimen.js';
import { runZiweiPaipan } from './paipan-runners/ziwei.js';

export type SkillParamType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'array'
  | 'object';

export interface SkillParamProperty {
  type: SkillParamType | SkillParamType[];
  description: string;
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: { type: SkillParamType; enum?: unknown[] };
  properties?: Record<string, SkillParamProperty>;
  required?: string[];
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

export interface SkillParametersSchema {
  type: 'object';
  properties: Record<string, SkillParamProperty>;
  required?: string[];
  conditionalRequired?: SkillConditionalRequirement[];
  atLeastOneOf?: string[][];
  allOrNoneOf?: string[][];
  examples?: SkillExamplePayload[];
}

export type PaipanRunner = (input: Record<string, unknown>) => Promise<unknown>;

export interface PaipanRegistryEntry {
  dir: string;
  name: string;
  description: string;
  trigger: string;
  runner: PaipanRunner;
  parameters?: SkillParametersSchema;
}

interface PaipanRegistryConfig {
  displayName: string;
  description: string;
  trigger: string;
  runner: PaipanRunner;
  parameters?: SkillParametersSchema;
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
        'method=manual 时必填：6 位爻字符串，每位取值 6/7/8/9（6=老阴动、7=少阳、8=少阴、9=老阳动），从初爻到上爻。例 "789678"',
    },
    numbers: {
      type: 'array',
      description: 'method=three 时长度必须为 3；method=array 时长度 >= 2',
      items: { type: 'integer' },
    },
    datetime: {
      type: 'string',
      description: '排盘时间，格式 "YYYY-MM-DD HH:mm"，默认当前时间',
    },
  },
};

const PAIPAN_REGISTRY_CONFIG: Record<string, PaipanRegistryConfig> = {
  'bazi-paipan': {
    displayName: '八字排盘',
    description:
      '八字排盘：四柱、大运、完整流年、格局，基于 bazi-ts-lib 本地确定性算法计算。',
    trigger: '用户询问八字、四柱、大运、流年、格局等命理相关问题',
    runner: runBaziPaipan,
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
          items: {
            type: 'string',
            enum: ['bazi', 'fortune', 'pattern'],
          },
        },
      },
      required: ['solarDate', 'hour', 'gender'],
    },
  },
  'iching-paipan': {
    displayName: '六爻排盘',
    description:
      '六爻纳甲排盘：返回本卦、变卦、互卦、六亲、六兽、世应、伏神、旬空、月建等确定性数据。',
    trigger:
      '用户询问六爻、纳甲、六亲、世应、伏神、动爻、用神、飞伏等六爻占卜相关问题',
    runner: runIchingPaipan,
    parameters: ichingLikeParameters,
  },
  'jingzhan-paipan': {
    displayName: '经占排盘',
    description:
      '周易经占排盘：按大衍筮法、略筮法或指定卦爻生成卦象与取辞数据。',
    trigger:
      '用户询问周易、易经、占卜、起卦、大衍筮法、略筮法、卦辞、爻辞等经占排盘相关问题',
    runner: runJingzhanPaipan,
    parameters: ichingLikeParameters,
  },
  'qimen-paipan': {
    displayName: '奇门遁甲排盘',
    description:
      '奇门遁甲排盘：按指定时间或当前时间生成时家奇门拆补盘与九宫数据。',
    trigger:
      '用户询问奇门遁甲、时家奇门、值符值使、八门九星、天地盘相关问题，或需要按指定时间起奇门局',
    runner: runQimenPaipan,
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
      examples: [
        {
          name: '默认当前时间起盘',
          value: {},
        },
        {
          name: '指定时间起盘',
          value: {
            solarDate: '2026-04-17',
            hour: 14,
            minute: 30,
          },
        },
      ],
    },
  },
  'liuren-paipan': {
    displayName: '大六壬排盘',
    description:
      '大六壬排盘：按当前、指定或随机时辰生成天地盘、四课、三传、遁干和神煞。',
    trigger:
      '用户询问大六壬、六壬、天地盘、四课、三传、月将、贵人天将等六壬相关问题，或需要按时间起六壬课',
    runner: runLiurenPaipan,
    parameters: {
      type: 'object',
      properties: {
        solarDate: {
          type: 'string',
          description: '阳历日期 YYYY-MM-DD。不传则用当前时间；只传日期和 randomNumber 时按今日/该日随机时辰',
        },
        hour: {
          type: 'integer',
          description: '小时 0-23（24 小时制）。与 solarDate 一起传为指定时间',
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
        randomNumber: {
          type: 'integer',
          description: '可选随机数种子；传入后稳定映射到 12 个时辰之一，不传则真实随机',
        },
        timeMode: {
          type: 'string',
          description: '前端辅助标识：now/custom/random',
          enum: ['now', 'custom', 'random'],
        },
      },
      examples: [
        {
          name: '默认当前时间起课',
          value: {},
        },
        {
          name: '指定时间起课',
          value: {
            solarDate: '2026-06-02',
            hour: 12,
            minute: 30,
          },
        },
        {
          name: '随机数起今日时辰',
          value: {
            randomNumber: 8848,
          },
        },
      ],
    },
  },
  'ziwei-paipan': {
    displayName: '紫微斗数排盘',
    description: '紫微斗数排盘：根据阳历出生时间和性别生成十二宫星盘。',
    trigger: '用户询问紫微斗数、紫微排盘、命宫身宫、大限流年等相关问题',
    runner: runZiweiPaipan,
    parameters: {
      type: 'object',
      properties: {
        solarDate: {
          type: 'string',
          description: '阳历出生日期，格式 YYYY-MM-DD，例如 2000-08-16',
        },
        hour: {
          type: 'integer',
          description: '出生小时，24 小时制，0-23',
          minimum: 0,
          maximum: 23,
        },
        minute: {
          type: 'integer',
          description: '出生分钟，0-59，用于判断早晚子时边界',
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
        dayDivide: {
          type: 'string',
          description: '晚子时换日规则：forward=晚子时算次日；current=晚子时算当日',
          enum: ['forward', 'current'],
          default: 'forward',
        },
        yearDivide: {
          type: 'string',
          description: '年干支分界规则：normal=农历新年分界；exact=立春分界',
          enum: ['normal', 'exact'],
          default: 'normal',
        },
        horoscopeDivide: {
          type: 'string',
          description: '运限分界规则：normal=农历新年分界；exact=立春分界',
          enum: ['normal', 'exact'],
          default: 'normal',
        },
        ageDivide: {
          type: 'string',
          description: '小限分界规则：normal=自然年分界；birthday=生日分界',
          enum: ['normal', 'birthday'],
          default: 'normal',
        },
        horoscope: {
          type: 'object',
          description: '可选：叠加运盘（大限/小限/流年/流月/流日/流时）',
          properties: {
            date: {
              type: 'string',
              description: '运盘目标日期 YYYY-MM-DD，例如 2026-04-17',
            },
            scopes: {
              type: 'array',
              description: '要返回的运盘尺度，默认 [decadal, yearly]',
              items: {
                type: 'string',
                enum: [
                  'decadal',
                  'age',
                  'yearly',
                  'monthly',
                  'daily',
                  'hourly',
                ],
              },
            },
          },
          required: ['date'],
        },
      },
      required: ['solarDate', 'hour', 'gender'],
    },
  },
};

export function listPaipanRegistry(): PaipanRegistryEntry[] {
  return Object.entries(PAIPAN_REGISTRY_CONFIG).map(([dir, config]) => ({
    dir,
    name: config.displayName,
    description: config.description,
    trigger: config.trigger,
    runner: config.runner,
    parameters: config.parameters,
  }));
}

export function getPaipanRegistryEntry(
  skillDir: string,
): PaipanRegistryEntry | undefined {
  const config = PAIPAN_REGISTRY_CONFIG[skillDir];
  if (!config) return undefined;
  return {
    dir: skillDir,
    name: config.displayName,
    description: config.description,
    trigger: config.trigger,
    runner: config.runner,
    parameters: config.parameters,
  };
}
