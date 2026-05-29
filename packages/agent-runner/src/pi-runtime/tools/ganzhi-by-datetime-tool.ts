import {
  defineTool,
  type AgentToolResult,
  type ToolDefinition as PiToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {
  LunarHour,
  LunarSect2EightCharProvider,
  SolarTime,
} from 'tyme4ts';
import { Type, type Static } from 'typebox';

import {
  completePiToolExecution,
  type PiToolRuntimeOptions,
} from './tool-execution.js';

const ganzhiByDatetimeParamsSchema = Type.Object({
  year: Type.Number({
    description: '公历年，例如 2026。',
  }),
  month: Type.Number({
    description: '公历月，1-12。',
  }),
  day: Type.Number({
    description: '公历日，1-31。',
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
  eightCharProvider: Type.Optional(
    Type.String({
      description:
        '八字流派：default 使用 tyme4ts 默认流派；lunar_sect2 使用 LunarSect2EightCharProvider。',
    }),
  ),
});

type GanzhiByDatetimeParams = Static<typeof ganzhiByDatetimeParamsSchema>;

interface GanZhiPillars {
  year: string;
  month: string;
  day: string;
  hour: string;
  eightChar: string;
}

interface PiGanzhiByDatetimeDetails {
  output: string;
  isError: boolean;
  input: {
    year?: number;
    month?: number;
    day?: number;
    hour: number;
    minute: number;
    second: number;
    eightCharProvider: 'default' | 'lunar_sect2';
  };
  solar?: string;
  lunar?: string;
  ganzhi?: GanZhiPillars;
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
 * 注意：本工具按输入的公历年月日时分秒计算，不负责把自然语言日期解析成时间字段。
 */
export interface CreatePiGanzhiByDatetimeToolOptions
  extends PiToolRuntimeOptions {}

function readInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.trunc(value);
}

function normalizeProvider(value: unknown): 'default' | 'lunar_sect2' {
  return value === 'lunar_sect2' ? 'lunar_sect2' : 'default';
}

function normalizeParams(args: unknown): GanzhiByDatetimeParams {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return {
      year: Number.NaN,
      month: Number.NaN,
      day: Number.NaN,
    };
  }
  const raw = args as Record<string, unknown>;
  return {
    year: readInteger(raw.year) ?? Number.NaN,
    month: readInteger(raw.month) ?? Number.NaN,
    day: readInteger(raw.day) ?? Number.NaN,
    hour: readInteger(raw.hour) ?? 0,
    minute: readInteger(raw.minute) ?? 0,
    second: readInteger(raw.second) ?? 0,
    eightCharProvider: normalizeProvider(raw.eightCharProvider),
  };
}

function buildInput(params: GanzhiByDatetimeParams): PiGanzhiByDatetimeDetails['input'] {
  return {
    year: Number.isFinite(params.year) ? params.year : undefined,
    month: Number.isFinite(params.month) ? params.month : undefined,
    day: Number.isFinite(params.day) ? params.day : undefined,
    hour: readInteger(params.hour) ?? 0,
    minute: readInteger(params.minute) ?? 0,
    second: readInteger(params.second) ?? 0,
    eightCharProvider: normalizeProvider(params.eightCharProvider),
  };
}

function buildOutput(details: Omit<PiGanzhiByDatetimeDetails, 'output'>): string {
  return JSON.stringify(details, null, 2);
}

function withEightCharProvider<T>(
  provider: 'default' | 'lunar_sect2',
  compute: () => T,
): T {
  const previous = LunarHour.provider;
  try {
    if (provider === 'lunar_sect2') {
      LunarHour.provider = new LunarSect2EightCharProvider();
    }
    return compute();
  } finally {
    LunarHour.provider = previous;
  }
}

/**
 * 创建 Pi 的指定公历时间干支工具。
 *
 * 参数：CreatePiGanzhiByDatetimeToolOptions。
 * 返回：可注册到 Pi customTools 的 get_ganzhi_by_datetime 工具定义。
 * 注意：输入必须是明确的公历字段，避免模型把模糊时间直接交给确定性算法。
 */
export function createPiGanzhiByDatetimeTool(
  options: CreatePiGanzhiByDatetimeToolOptions,
): PiToolDefinition {
  return defineTool({
    name: 'get_ganzhi_by_datetime',
    label: 'get_ganzhi_by_datetime',
    description:
      '根据明确的公历年月日时分秒，计算年柱、月柱、日柱、时柱等干支数据。',
    promptSnippet:
      'Use get_ganzhi_by_datetime for deterministic GanZhi data of a specific Gregorian date/time.',
    promptGuidelines: [
      '调用前先把用户日期整理成明确的公历 year/month/day/hour/minute/second。',
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
      const input = buildInput(params);
      const provider = input.eightCharProvider;

      try {
        const result = withEightCharProvider(provider, () => {
          const solarTime = SolarTime.fromYmdHms(
            input.year ?? Number.NaN,
            input.month ?? Number.NaN,
            input.day ?? Number.NaN,
            input.hour,
            input.minute,
            input.second,
          );
          const lunarHour = solarTime.getLunarHour();
          const sixtyCycleHour = solarTime.getSixtyCycleHour();
          const eightChar = lunarHour.getEightChar();
          return {
            solarTime,
            lunarHour,
            sixtyCycleHour,
            eightChar,
          };
        });

        const details: PiGanzhiByDatetimeDetails = {
          output: '',
          isError: false,
          input,
          solar: result.solarTime.toString(),
          lunar: result.lunarHour.toString(),
          ganzhi: {
            year: result.eightChar.getYear().toString(),
            month: result.eightChar.getMonth().toString(),
            day: result.eightChar.getDay().toString(),
            hour: result.eightChar.getHour().toString(),
            eightChar: result.eightChar.getName(),
          },
          solarTerm: result.solarTime.getTerm().toString(),
        };
        details.output = buildOutput(details);

        return completePiToolExecution({
          options,
          toolCallId,
          toolName: 'get_ganzhi_by_datetime',
          params: params as Record<string, unknown>,
          output: details.output,
          details,
          isError: false,
          traceType: 'pi_ganzhi_by_datetime_completed',
          startedAt,
          traceFields: {
            provider,
            solar: details.solar,
          },
        });
      } catch (err) {
        const details: PiGanzhiByDatetimeDetails = {
          output: '',
          isError: true,
          input,
          error: err instanceof Error ? err.message : String(err),
        };
        details.output = buildOutput(details);

        return completePiToolExecution({
          options,
          toolCallId,
          toolName: 'get_ganzhi_by_datetime',
          params: params as Record<string, unknown>,
          output: details.output,
          details,
          isError: true,
          traceType: 'pi_ganzhi_by_datetime_completed',
          startedAt,
          traceFields: { provider },
        });
      }
    },
  });
}
