import {
  EightChar,
  ThreePillars,
  type SolarDay,
  type SolarTime,
} from 'tyme4ts';
import type {
  PaipanGanzhiReverseMatchDto,
  PaipanGanzhiReverseRequestDto,
  PaipanGanzhiReverseResponseDto,
} from '@fateclaw/contracts/chat';

import { fail, ok, type ServiceResult } from '../../shared/service-result.js';

const MAX_REVERSE_YEAR_SPAN = 240;
const DEFAULT_REVERSE_LIMIT = 50;
const MAX_REVERSE_LIMIT = 200;
const STEMS = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
const BRANCHES = [
  '子',
  '丑',
  '寅',
  '卯',
  '辰',
  '巳',
  '午',
  '未',
  '申',
  '酉',
  '戌',
  '亥',
];
const GANZHI_PATTERN =
  /[甲乙丙丁戊己庚辛壬癸][子丑寅卯辰巳午未申酉戌亥]/u;
const VALID_SIXTY_CYCLES = new Set(
  Array.from({ length: 60 }, (_, index) => {
    return `${STEMS[index % STEMS.length]}${BRANCHES[index % BRANCHES.length]}`;
  }),
);

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

function normalizePillar(value: unknown): string | undefined {
  const raw = readString(value);
  if (!raw) return undefined;
  const matched = raw.match(GANZHI_PATTERN);
  if (!matched) return undefined;
  const pillar = matched[0];
  return VALID_SIXTY_CYCLES.has(pillar) ? pillar : undefined;
}

function normalizeRequest(
  raw: unknown,
): PaipanGanzhiReverseRequestDto | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const startYear = readInteger(source.startYear);
  const endYear = readInteger(source.endYear);
  if (startYear === undefined || endYear === undefined) return null;

  return {
    year: normalizePillar(source.year) ?? '',
    month: normalizePillar(source.month) ?? '',
    day: normalizePillar(source.day) ?? '',
    hour: normalizePillar(source.hour),
    startYear,
    endYear,
    limit: normalizeLimit(source.limit),
  };
}

function validateInput(input: PaipanGanzhiReverseRequestDto): string | null {
  if (!input.year || !input.month || !input.day) {
    return '必须提供合法的年柱、月柱、日柱干支，例如 丙午。';
  }
  if (input.startYear > input.endYear) {
    return '起始年份必须小于或等于结束年份。';
  }
  if (input.endYear - input.startYear > MAX_REVERSE_YEAR_SPAN) {
    return `年份跨度不能超过 ${MAX_REVERSE_YEAR_SPAN} 年。`;
  }
  return null;
}

function solarDayToMatch(day: SolarDay): PaipanGanzhiReverseMatchDto {
  return {
    solar: day.toString(),
    year: day.getYear(),
    month: day.getMonth(),
    day: day.getDay(),
  };
}

function solarTimeToMatch(time: SolarTime): PaipanGanzhiReverseMatchDto {
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

/**
 * 根据三柱或四柱干支反推公历候选。
 *
 * @param rawInput HTTP 请求体中的反推参数。
 * @returns 标准 service result；参数错误返回 400，计算异常返回 500。
 */
export function reverseGanzhiForPaipan(
  rawInput: unknown,
): ServiceResult<PaipanGanzhiReverseResponseDto> {
  const input = normalizeRequest(rawInput);
  if (!input) {
    return fail(400, '缺少有效的干支反推参数');
  }

  const validationError = validateInput(input);
  if (validationError) {
    return fail(400, validationError);
  }

  try {
    const mode = input.hour ? 'eight_char' : 'three_pillars';
    const matches = input.hour
      ? new EightChar(input.year, input.month, input.day, input.hour)
          .getSolarTimes(input.startYear, input.endYear)
          .map(solarTimeToMatch)
      : new ThreePillars(input.year, input.month, input.day)
          .getSolarDays(input.startYear, input.endYear)
          .map(solarDayToMatch);
    const limit = normalizeLimit(input.limit);

    return ok({
      mode,
      input: { ...input, limit },
      matches: matches.slice(0, limit),
      total: matches.length,
      truncated: matches.length > limit,
    });
  } catch {
    return fail(500, '干支反推失败，请检查输入后重试');
  }
}
