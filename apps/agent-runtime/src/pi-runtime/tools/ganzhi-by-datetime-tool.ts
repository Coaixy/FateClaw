import {
  defineTool,
  type AgentToolResult,
  type ToolDefinition as PiToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {
  LunarHour,
  SolarTime,
} from 'tyme4ts';
import { Type, type Static } from 'typebox';

import {
  makeToolResponder,
  type PiToolRuntimeOptions,
} from './tool-execution.js';
import {
  buildCalendarDetailsFromSolarTime,
  eightCharProviderSchema,
  isValidIanaTimeZone,
  normalizeEightCharProvider,
  type PiCalendarDetails,
  type PiEightCharProvider,
} from './calendar-details.js';
import {
  readBoolean,
  readInteger,
  readString,
  toJsonOutput,
} from './param-utils.js';

const ganzhiByDatetimeParamsSchema = Type.Object({
  inputCalendar: Type.Optional(
    Type.String({
      description:
        '输入日期类型：gregorian 表示公历；lunar 表示农历。默认 gregorian。',
    }),
  ),
  year: Type.Number({
    description: '年份；inputCalendar=gregorian 时为公历年，inputCalendar=lunar 时为农历年。',
  }),
  month: Type.Number({
    description:
      '月份，1-12；inputCalendar=lunar 时可配合 isLeapMonth=true 表示闰月。',
  }),
  day: Type.Number({
    description: '日，公历或农历取决于 inputCalendar。',
  }),
  hour: Type.Optional(
    Type.Number({
      description: '小时，0-23；不传默认为 0。',
    }),
  ),
  minute: Type.Optional(
    Type.Number({
      description: '分钟，0-59；不传默认为 0。',
    }),
  ),
  second: Type.Optional(
    Type.Number({
      description: '秒，0-59；不传默认为 0。',
    }),
  ),
  isLeapMonth: Type.Optional(
    Type.Boolean({
      description:
        'inputCalendar=lunar 时是否为闰月；也可传负数 month 表示闰月。',
    }),
  ),
  timezone: Type.Optional(
    Type.String({
      description:
        'IANA 时区名称；用于标注输入民用时间所属时区，不传时不做时区标注。',
    }),
  ),
  eightCharProvider: eightCharProviderSchema,
});

type GanzhiByDatetimeParams = Static<typeof ganzhiByDatetimeParamsSchema>;

interface PiGanzhiByDatetimeDetails {
  output: string;
  isError: boolean;
  input: {
    inputCalendar: 'gregorian' | 'lunar';
    year?: number;
    month?: number;
    day?: number;
    hour: number;
    minute: number;
    second: number;
    isLeapMonth: boolean;
    timezone?: string;
    eightCharProvider: PiEightCharProvider;
  };
  calendar?: PiCalendarDetails;
  solar?: string;
  lunar?: string;
  ganzhi?: PiCalendarDetails['ganzhi'];
  solarTerm?: string;
  error?: string;
}

/**
 * 创建指定公历时间干支工具所需的依赖。
 *
 * 参数：
 * - requestScope：当前请求作用域。
 * - recordExecution：工具执行记录回调。
 *
 * 注意：本工具按明确日期字段计算，不负责把自然语言日期解析成时间字段。
 */
export interface CreatePiGanzhiByDatetimeToolOptions
  extends PiToolRuntimeOptions {}

function normalizeInputCalendar(value: unknown): 'gregorian' | 'lunar' {
  return value === 'lunar' ? 'lunar' : 'gregorian';
}

function normalizeParams(args: unknown): GanzhiByDatetimeParams {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return {
      inputCalendar: 'gregorian',
      year: Number.NaN,
      month: Number.NaN,
      day: Number.NaN,
    };
  }
  const raw = args as Record<string, unknown>;
  return {
    inputCalendar: normalizeInputCalendar(raw.inputCalendar),
    year: readInteger(raw.year) ?? Number.NaN,
    month: readInteger(raw.month) ?? Number.NaN,
    day: readInteger(raw.day) ?? Number.NaN,
    hour: readInteger(raw.hour) ?? 0,
    minute: readInteger(raw.minute) ?? 0,
    second: readInteger(raw.second) ?? 0,
    isLeapMonth: readBoolean(raw.isLeapMonth),
    timezone: readString(raw.timezone),
    eightCharProvider: normalizeEightCharProvider(raw.eightCharProvider),
  };
}

function buildInput(params: GanzhiByDatetimeParams): PiGanzhiByDatetimeDetails['input'] {
  // params 已由 normalizeParams 规范化：数值字段为整数或 NaN、布尔/字符串已归一，
  // 因此这里直接信任，不再二次 readInteger/readBoolean/readString。
  const inputCalendar = normalizeInputCalendar(params.inputCalendar);
  const month = Number.isFinite(params.month) ? params.month : undefined;
  const isNegativeLunarMonth =
    inputCalendar === 'lunar' && month !== undefined && month < 0;
  return {
    inputCalendar,
    year: Number.isFinite(params.year) ? params.year : undefined,
    month:
      month !== undefined
        ? inputCalendar === 'lunar'
          ? Math.abs(month)
          : month
        : undefined,
    day: Number.isFinite(params.day) ? params.day : undefined,
    hour: params.hour ?? 0,
    minute: params.minute ?? 0,
    second: params.second ?? 0,
    isLeapMonth:
      inputCalendar === 'lunar'
        ? (params.isLeapMonth ?? isNegativeLunarMonth)
        : false,
    timezone: params.timezone,
    eightCharProvider: normalizeEightCharProvider(params.eightCharProvider),
  };
}

function buildSolarTime(
  input: PiGanzhiByDatetimeDetails['input'],
): SolarTime {
  if (input.inputCalendar === 'lunar') {
    const lunarMonth =
      input.isLeapMonth && input.month !== undefined
        ? -input.month
        : input.month;
    return LunarHour.fromYmdHms(
      input.year ?? Number.NaN,
      lunarMonth ?? Number.NaN,
      input.day ?? Number.NaN,
      input.hour,
      input.minute,
      input.second,
    ).getSolarTime();
  }
  return SolarTime.fromYmdHms(
    input.year ?? Number.NaN,
    input.month ?? Number.NaN,
    input.day ?? Number.NaN,
    input.hour,
    input.minute,
    input.second,
  );
}

/**
 * 创建 Pi 的指定公历时间干支工具。
 *
 * 参数：CreatePiGanzhiByDatetimeToolOptions。
 * 返回：可注册到 Pi customTools 的 get_ganzhi_by_datetime 工具定义。
 * 注意：输入必须是明确的公历或农历字段，避免模型把模糊时间直接交给确定性算法。
 */
export function createPiGanzhiByDatetimeTool(
  options: CreatePiGanzhiByDatetimeToolOptions,
): PiToolDefinition {
  return defineTool({
    name: 'get_ganzhi_by_datetime',
    label: 'get_ganzhi_by_datetime',
    description:
      '根据明确的公历或农历年月日时分秒，完成日期归一化，并计算农历、节气、年柱、月柱、日柱、时柱等数据。',
    promptSnippet:
      'Use get_ganzhi_by_datetime for deterministic calendar conversion and GanZhi data of a specific date/time.',
    promptGuidelines: [
      '调用前先把用户日期整理成明确的 year/month/day/hour/minute/second，并设置 inputCalendar。',
      '用户给农历生日、闰月或阴历日期时，设置 inputCalendar=lunar；闰月设置 isLeapMonth=true。',
      '用户没有给时辰时可省略 hour，工具会按 00:00:00 计算并在结果中体现。',
      '需要真实当前时间的干支时，先调用 get_current_time 获取当前日期时间。',
    ],
    parameters: ganzhiByDatetimeParamsSchema,
    executionMode: 'sequential',
    prepareArguments: normalizeParams,
    async execute(
      toolCallId,
      params,
    ): Promise<AgentToolResult<PiGanzhiByDatetimeDetails>> {
      const startedAt = Date.now();
      const respond = makeToolResponder({
        options,
        toolCallId,
        toolName: 'get_ganzhi_by_datetime',
        params: params as Record<string, unknown>,
        traceType: 'pi_ganzhi_by_datetime_completed',
        startedAt,
      });
      const input = buildInput(params);
      const provider = input.eightCharProvider;

      if (input.timezone && !isValidIanaTimeZone(input.timezone)) {
        const details: PiGanzhiByDatetimeDetails = {
          output: '',
          isError: true,
          input,
          error: `无效时区：${input.timezone}`,
        };
        details.output = toJsonOutput(details);

        return respond(details, {
          provider,
          inputCalendar: input.inputCalendar,
          timezone: input.timezone,
        });
      }

      try {
        const solarTime = buildSolarTime(input);
        const calendar = buildCalendarDetailsFromSolarTime(solarTime, provider);

        const details: PiGanzhiByDatetimeDetails = {
          output: '',
          isError: false,
          input,
          calendar,
          solar: calendar.solar,
          lunar: calendar.lunar,
          ganzhi: calendar.ganzhi,
          solarTerm: calendar.solarTerm,
        };
        details.output = toJsonOutput(details);

        return respond(details, {
          provider,
          inputCalendar: input.inputCalendar,
          timezone: input.timezone,
          solar: details.solar,
        });
      } catch (err) {
        const details: PiGanzhiByDatetimeDetails = {
          output: '',
          isError: true,
          input,
          error: err instanceof Error ? err.message : String(err),
        };
        details.output = toJsonOutput(details);

        return respond(details, {
          provider,
          inputCalendar: input.inputCalendar,
          timezone: input.timezone,
        });
      }
    },
  });
}
