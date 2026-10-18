import { describe, expect, it } from 'vitest';

import {
  runBaziPaipan,
  type BaziPaipanResult,
} from '#modules/chat/paipan-runners/bazi';

interface AnnualFortuneItem {
  year: number;
  sixtyCycle: string;
  heavenStem: string;
  earthBranch: string;
  lunarYear: string;
}

interface DecadeFortuneItem {
  sixtyCycle: string;
  startAge: number;
  endAge: number;
  startYear: number;
  endYear: number;
  label?: string;
}

async function runPaipan(
  include: string[] = ['fortune'],
  input: Record<string, unknown> = {},
): Promise<BaziPaipanResult> {
  return runBaziPaipan({
    solarDate: '1990-05-15',
    hour: 10,
    minute: 30,
    gender: '男',
    ...input,
    include,
  });
}

describe('bazi-paipan reference alignment', () => {
  it('matches the reference natal pillars and decade fortune sequence', async () => {
    const result = await runPaipan(['bazi', 'fortune']);

    expect(result.bazi?.baziString).toBe('庚午 辛巳 庚辰 辛巳');
    expect(
      (result.fortune?.decades as DecadeFortuneItem[]).map((item) => [
        item.startYear,
        item.startAge,
        item.sixtyCycle,
        item.label ?? '',
      ]),
    ).toEqual([
      [1990, 1, '', '小运'],
      [1997, 8, '壬午', ''],
      [2007, 18, '癸未', ''],
      [2017, 28, '甲申', ''],
      [2027, 38, '乙酉', ''],
      [2037, 48, '丙戌', ''],
      [2047, 58, '丁亥', ''],
      [2057, 68, '戊子', ''],
      [2067, 78, '己丑', ''],
      [2077, 88, '庚寅', ''],
      [2087, 98, '辛卯', ''],
      [2097, 108, '壬辰', ''],
    ]);
  });

  it('uses the same lunar-year pillar rule as the reference backend', async () => {
    const result = await runPaipan(['bazi'], {
      solarDate: '1995-02-04',
      hour: 0,
      minute: 20,
      gender: '女',
    });

    expect(result.bazi?.baziString).toBe('乙亥 丁丑 丙寅 戊子');
  });

  it('keeps late-year zishi pillars aligned with the reference backend', async () => {
    const result = await runPaipan(['bazi', 'fortune'], {
      solarDate: '2000-01-01',
      hour: 23,
      minute: 30,
      gender: '男',
    });

    expect(result.bazi?.baziString).toBe('己卯 丙子 己未 甲子');
    expect(
      (result.fortune?.decades as DecadeFortuneItem[]).map((item) => [
        item.startYear,
        item.startAge,
        item.sixtyCycle,
        item.label ?? '',
      ]),
    ).toEqual([
      [2000, 1, '', '小运'],
      [2008, 9, '乙亥', ''],
      [2018, 19, '甲戌', ''],
      [2028, 29, '癸酉', ''],
      [2038, 39, '壬申', ''],
      [2048, 49, '辛未', ''],
      [2058, 59, '庚午', ''],
      [2068, 69, '己巳', ''],
      [2078, 79, '戊辰', ''],
      [2088, 89, '丁卯', ''],
      [2098, 99, '丙寅', ''],
      [2108, 109, '乙丑', ''],
    ]);
  });
});

describe('bazi-paipan annual fortune', () => {
  it('uses the real Gregorian year ganzhi for 2026', async () => {
    const result = await runPaipan();
    const annual2026 = (
      result.fortune?.annuals as AnnualFortuneItem[] | undefined
    )?.find((item) => item.year === 2026);

    expect(annual2026).toMatchObject({
      year: 2026,
      sixtyCycle: '丙午',
      heavenStem: '丙',
      earthBranch: '午',
      lunarYear: '丙午年',
    });
  });

  it('keeps consecutive annual ganzhi aligned with real years', async () => {
    const result = await runPaipan();
    const annuals = (result.fortune?.annuals as AnnualFortuneItem[] | undefined)
      ?.filter((item) => item.year >= 2024 && item.year <= 2028)
      .map((item) => [item.year, item.sixtyCycle]);

    expect(annuals).toEqual([
      [2024, '甲辰'],
      [2025, '乙巳'],
      [2026, '丙午'],
      [2027, '丁未'],
      [2028, '戊申'],
    ]);
  });
});
