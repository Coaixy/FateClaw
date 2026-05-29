import {
  defineTool,
  type AgentToolResult,
  type ToolDefinition as PiToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';

import {
  completePiToolExecution,
  type PiToolRuntimeOptions,
} from './tool-execution.js';

const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

const currentTimeParamsSchema = Type.Object({
  timezone: Type.Optional(
    Type.String({
      description:
        'IANA 时区名称，例如 Asia/Shanghai、America/New_York；不传时默认 Asia/Shanghai。',
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

function normalizeParams(args: unknown): CurrentTimeParams {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  const raw = args as Record<string, unknown>;
  return {
    timezone: readStringParam(raw.timezone),
  };
}

function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
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
      '获取当前服务器时间，并按指定 IANA 时区输出本地时间、ISO 时间和 Unix 毫秒时间戳。',
    promptSnippet:
      'Use get_current_time when the answer depends on the real current time.',
    promptGuidelines: [
      '需要“现在”“当前时间”“今天此刻”等真实时间时先调用本工具。',
      'timezone 必须是 IANA 时区名称；不确定用户时区时使用默认 Asia/Shanghai。',
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
      const date = options.now ? options.now() : new Date();

      if (!isValidTimeZone(timezone)) {
        const details: PiCurrentTimeDetails = {
          output: '',
          isError: true,
          timezone,
          iso: date.toISOString(),
          unixMs: date.getTime(),
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
      const details: PiCurrentTimeDetails = {
        output: '',
        isError: false,
        timezone,
        iso: date.toISOString(),
        unixMs: date.getTime(),
        local: formatLocal(parts),
        parts,
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
