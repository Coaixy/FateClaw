import {
  defineTool,
  type AgentToolResult,
  type ToolDefinition as PiToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {
  EightChar,
  ThreePillars,
  type SolarDay,
  type SolarTime,
} from 'tyme4ts';
import { Type, type Static } from 'typebox';

import {
  completePiToolExecution,
  type PiToolRuntimeOptions,
} from './tool-execution.js';

const MAX_REVERSE_YEAR_SPAN = 240;
const DEFAULT_REVERSE_LIMIT = 50;
const MAX_REVERSE_LIMIT = 200;

const ganzhiReverseParamsSchema = Type.Object({
  year: Type.String({
    description: '年柱干支，例如 丙午。',
  }),
  month: Type.String({
    description: '月柱干支，例如 壬辰。',
  }),
  day: Type.String({
    description: '日柱干支，例如 己巳。',
  }),
  hour: Type.Optional(
    Type.String({
      description: '时柱干支，例如 辛未；不传时按三柱反推日期。',
    }),
  ),
  startYear: Type.Number({
    description: '反推搜索起始公历年，必须小于等于 endYear。',
  }),
  endYear: Type.Number({
    description: '反推搜索结束公历年，最多允许 240 年跨度。',
  }),
  limit: Type.Optional(
    Type.Number({
      description: '最多返回多少个候选结果，默认 50，最大 200。',
    }),
  ),
});

type GanzhiReverseParams = Static<typeof ganzhiReverseParamsSchema>;

interface ReverseInput {
  year?: string;
  month?: string;
  day?: string;
  hour?: string;
  startYear?: number;
  endYear?: number;
  limit: number;
}

interface ReverseMatch {
  solar: string;
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
}

interface PiGanzhiReverseDetails {
  output: string;
  isError: boolean;
  input: ReverseInput;
  mode: 'three_pillars' | 'eight_char';
  matches: ReverseMatch[];
  total: number;
  truncated: boolean;
  error?: string;
}

/**
 * 创建干支反推工具所需的依赖。
 *
 * 参数：
 * - requestScope：当前请求作用域。
 * - recordExecution：工具执行记录回调。
 *
 * 注意：反推必须限定公历年份范围，避免模型触发无界搜索。
 */
export interface CreatePiGanzhiReverseToolOptions
  extends PiToolRuntimeOptions {}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.trunc(value);
}

function normalizeLimit(value: unknown): number {
  const limit = readInteger(value) ?? DEFAULT_REVERSE_LIMIT;
  if (limit <= 0) return DEFAULT_REVERSE_LIMIT;
  return Math.min(limit, MAX_REVERSE_LIMIT);
}

function normalizeParams(args: unknown): GanzhiReverseParams {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return {
      year: '',
      month: '',
      day: '',
      startYear: Number.NaN,
      endYear: Number.NaN,
    };
  }
  const raw = args as Record<string, unknown>;
  return {
    year: readString(raw.year) ?? '',
    month: readString(raw.month) ?? '',
    day: readString(raw.day) ?? '',
    hour: readString(raw.hour),
    startYear: readInteger(raw.startYear) ?? Number.NaN,
    endYear: readInteger(raw.endYear) ?? Number.NaN,
    limit: normalizeLimit(raw.limit),
  };
}

function buildInput(params: GanzhiReverseParams): ReverseInput {
  return {
    year: readString(params.year),
    month: readString(params.month),
    day: readString(params.day),
    hour: readString(params.hour),
    startYear: Number.isFinite(params.startYear) ? params.startYear : undefined,
    endYear: Number.isFinite(params.endYear) ? params.endYear : undefined,
    limit: normalizeLimit(params.limit),
  };
}

function buildOutput(details: Omit<PiGanzhiReverseDetails, 'output'>): string {
  return JSON.stringify(details, null, 2);
}

function solarDayToMatch(day: SolarDay): ReverseMatch {
  return {
    solar: day.toString(),
    year: day.getYear(),
    month: day.getMonth(),
    day: day.getDay(),
  };
}

function solarTimeToMatch(time: SolarTime): ReverseMatch {
  return {
    solar: time.toString(),
    year: time.getYear(),
    month: time.getMonth(),
    day: time.getDay(),
    hour: time.getHour(),
    minute: time.getMinute(),
    second: time.getSecond(),
  };
}

function validateInput(input: ReverseInput): string | undefined {
  if (!input.year || !input.month || !input.day) {
    return '必须提供 year、month、day 三柱干支。';
  }
  if (input.startYear === undefined || input.endYear === undefined) {
    return '必须提供 startYear 和 endYear。';
  }
  if (input.startYear > input.endYear) {
    return 'startYear 必须小于或等于 endYear。';
  }
  if (input.endYear - input.startYear > MAX_REVERSE_YEAR_SPAN) {
    return `年份跨度不能超过 ${MAX_REVERSE_YEAR_SPAN} 年。`;
  }
  return undefined;
}

/**
 * 创建 Pi 的干支反推工具。
 *
 * 参数：CreatePiGanzhiReverseToolOptions。
 * 返回：可注册到 Pi customTools 的 reverse_ganzhi 工具定义。
 * 注意：传入时柱时按四柱反推具体时间；不传时柱时按三柱反推日期。
 */
export function createPiGanzhiReverseTool(
  options: CreatePiGanzhiReverseToolOptions,
): PiToolDefinition {
  return defineTool({
    name: 'reverse_ganzhi',
    label: 'reverse_ganzhi',
    description:
      '根据三柱或四柱干支，在指定公历年份范围内反推出可能的公历日期或日期时间。',
    promptSnippet:
      'Use reverse_ganzhi to search Gregorian dates/times from GanZhi pillars.',
    promptGuidelines: [
      '必须提供 startYear/endYear；范围越小结果越可靠、输出越短。',
      '只有年/月/日三柱时返回公历日期；同时提供时柱时返回具体公历时间。',
      '不要用本工具做无界历史搜索。',
    ],
    parameters: ganzhiReverseParamsSchema,
    executionMode: 'sequential',
    prepareArguments: normalizeParams,
    async execute(
      toolCallId,
      params,
    ): Promise<AgentToolResult<PiGanzhiReverseDetails>> {
      const startedAt = Date.now();
      const input = buildInput(params);
      const mode = input.hour ? 'eight_char' : 'three_pillars';
      const validationError = validateInput(input);

      if (validationError) {
        const details: PiGanzhiReverseDetails = {
          output: '',
          isError: true,
          input,
          mode,
          matches: [],
          total: 0,
          truncated: false,
          error: validationError,
        };
        details.output = buildOutput(details);
        return completePiToolExecution({
          options,
          toolCallId,
          toolName: 'reverse_ganzhi',
          params: params as Record<string, unknown>,
          output: details.output,
          details,
          isError: true,
          traceType: 'pi_ganzhi_reverse_completed',
          startedAt,
          traceFields: { mode },
        });
      }

      try {
        const startYear = input.startYear!;
        const endYear = input.endYear!;
        const candidates = input.hour
          ? new EightChar(
              input.year!,
              input.month!,
              input.day!,
              input.hour,
            )
              .getSolarTimes(startYear, endYear)
              .map(solarTimeToMatch)
          : new ThreePillars(input.year!, input.month!, input.day!)
              .getSolarDays(startYear, endYear)
              .map(solarDayToMatch);
        const matches = candidates.slice(0, input.limit);
        const details: PiGanzhiReverseDetails = {
          output: '',
          isError: false,
          input,
          mode,
          matches,
          total: candidates.length,
          truncated: candidates.length > matches.length,
        };
        details.output = buildOutput(details);

        return completePiToolExecution({
          options,
          toolCallId,
          toolName: 'reverse_ganzhi',
          params: params as Record<string, unknown>,
          output: details.output,
          details,
          isError: false,
          traceType: 'pi_ganzhi_reverse_completed',
          startedAt,
          traceFields: {
            mode,
            total: candidates.length,
            truncated: details.truncated,
          },
        });
      } catch (err) {
        const details: PiGanzhiReverseDetails = {
          output: '',
          isError: true,
          input,
          mode,
          matches: [],
          total: 0,
          truncated: false,
          error: err instanceof Error ? err.message : String(err),
        };
        details.output = buildOutput(details);

        return completePiToolExecution({
          options,
          toolCallId,
          toolName: 'reverse_ganzhi',
          params: params as Record<string, unknown>,
          output: details.output,
          details,
          isError: true,
          traceType: 'pi_ganzhi_reverse_completed',
          startedAt,
          traceFields: { mode },
        });
      }
    },
  });
}
