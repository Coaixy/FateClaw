import {
  defineTool,
  type AgentToolResult,
  type ToolDefinition as PiToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { SolarTime } from 'tyme4ts';
import { Type, type Static } from 'typebox';

import {
  completePiToolExecution,
  type PiToolRuntimeOptions,
} from './tool-execution.js';
import {
  buildCalendarDetailsFromSolarTime,
  isValidIanaTimeZone,
  normalizeEightCharProvider,
  type PiCalendarDetails,
  type PiEightCharProvider,
} from './calendar-details.js';

const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

const currentTimeParamsSchema = Type.Object({
  timezone: Type.Optional(
    Type.String({
      description:
        'IANA 时区名称，例如 Asia/Shanghai、America/New_York；不传时默认 Asia/Shanghai。',
    }),
  ),
  includeCalendar: Type.Optional(
    Type.Boolean({
      description:
        '是否返回当前时刻对应的农历、节气和干支详情；默认 false。',
    }),
  ),
  eightCharProvider: Type.Optional(
    Type.String({
      description:
        '八字流派：default 使用 tyme4ts 默认流派；lunar_sect2 使用 LunarSect2EightCharProvider。',
    }),
  ),
});

type CurrentTimeParams = Static<typeof currentTimeParamsSchema>;

interface ZonedDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
  timeZoneName?: string;
}

interface PiCurrentTimeDetails {
  output: string;
  isError: boolean;
  timezone: string;
  iso: string;
  unixMs: number;
  local?: string;
  parts?: ZonedDateTimeParts;
  includeCalendar?: boolean;
  eightCharProvider?: PiEightCharProvider;
  calendar?: PiCalendarDetails;
  error?: string;
}

/**
 * 创建当前时间工具所需的依赖。
 *
 * 参数：
 * - requestScope：当前请求作用域。
 * - recordExecution：工具执行记录回调。
 * - now：可选时钟函数，主要用于单元测试固定当前时间。
 * - defaultTimeZone：默认 IANA 时区；不传时使用 Asia/Shanghai。
 *
 * 注意：该工具返回服务器当前时刻在指定时区下的显示时间。
 */
export interface CreatePiCurrentTimeToolOptions
  extends PiToolRuntimeOptions {
  now?: () => Date;
  defaultTimeZone?: string;
}

function readStringParam(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readBooleanParam(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function normalizeParams(args: unknown): CurrentTimeParams {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  const raw = args as Record<string, unknown>;
  return {
    timezone: readStringParam(raw.timezone),
    includeCalendar: readBooleanParam(raw.includeCalendar),
    eightCharProvider: normalizeEightCharProvider(raw.eightCharProvider),
  };
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatLocal(parts: ZonedDateTimeParts): string {
  return [
    `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`,
    `${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}`,
  ].join(' ');
}

function getZonedParts(date: Date, timezone: string): ZonedDateTimeParts {
  const formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'long',
    timeZoneName: 'longOffset',
    hourCycle: 'h23',
  });
  const parts = new Map(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );

  return {
    year: Number(parts.get('year')),
    month: Number(parts.get('month')),
    day: Number(parts.get('day')),
    hour: Number(parts.get('hour')),
    minute: Number(parts.get('minute')),
    second: Number(parts.get('second')),
    weekday: parts.get('weekday') ?? '',
    timeZoneName: parts.get('timeZoneName'),
  };
}

function buildOutput(details: Omit<PiCurrentTimeDetails, 'output'>): string {
  return JSON.stringify(details, null, 2);
}

/**
 * 创建 Pi 的当前时间工具。
 *
 * 参数：CreatePiCurrentTimeToolOptions。
 * 返回：可注册到 Pi customTools 的 get_current_time 工具定义。
 * 注意：时区只接受 IANA 名称，避免模型把自然语言地点误当作时区。
 */
export function createPiCurrentTimeTool(
  options: CreatePiCurrentTimeToolOptions,
): PiToolDefinition {
  return defineTool({
    name: 'get_current_time',
    label: 'get_current_time',
    description:
      '获取当前服务器时间，并按指定 IANA 时区输出本地时间、ISO 时间、Unix 毫秒时间戳；可选返回当前农历、节气和干支。',
    promptSnippet:
      'Use get_current_time when the answer depends on the real current time.',
    promptGuidelines: [
      '需要“现在”“当前时间”“今天此刻”等真实时间时先调用本工具。',
      'timezone 必须是 IANA 时区名称；不确定用户时区时使用默认 Asia/Shanghai。',
      '需要当前农历、节气、今日干支或当前八字时，设置 includeCalendar=true。',
    ],
    parameters: currentTimeParamsSchema,
    executionMode: 'sequential',
    prepareArguments: normalizeParams,
    async execute(
      toolCallId,
      params,
    ): Promise<AgentToolResult<PiCurrentTimeDetails>> {
      const startedAt = Date.now();
      const timezone =
        params.timezone ?? options.defaultTimeZone ?? DEFAULT_TIME_ZONE;
      const includeCalendar = params.includeCalendar ?? false;
      const provider = normalizeEightCharProvider(params.eightCharProvider);
      const date = options.now ? options.now() : new Date();

      if (!isValidIanaTimeZone(timezone)) {
        const details: PiCurrentTimeDetails = {
          output: '',
          isError: true,
          timezone,
          iso: date.toISOString(),
          unixMs: date.getTime(),
          includeCalendar,
          eightCharProvider: provider,
          error: `无效时区：${timezone}`,
        };
        details.output = buildOutput(details);
        return completePiToolExecution({
          options,
          toolCallId,
          toolName: 'get_current_time',
          params: params as Record<string, unknown>,
          output: details.output,
          details,
          isError: true,
          traceType: 'pi_current_time_completed',
          startedAt,
          traceFields: { timezone },
        });
      }

      const parts = getZonedParts(date, timezone);
      const calendar = includeCalendar
        ? buildCalendarDetailsFromSolarTime(
            SolarTime.fromYmdHms(
              parts.year,
              parts.month,
              parts.day,
              parts.hour,
              parts.minute,
              parts.second,
            ),
            provider,
          )
        : undefined;
      const details: PiCurrentTimeDetails = {
        output: '',
        isError: false,
        timezone,
        iso: date.toISOString(),
        unixMs: date.getTime(),
        local: formatLocal(parts),
        parts,
        includeCalendar,
        eightCharProvider: provider,
        calendar,
      };
      details.output = buildOutput(details);

      return completePiToolExecution({
        options,
        toolCallId,
        toolName: 'get_current_time',
        params: params as Record<string, unknown>,
        output: details.output,
        details,
        isError: false,
        traceType: 'pi_current_time_completed',
        startedAt,
        traceFields: { timezone },
      });
    },
  });
}
