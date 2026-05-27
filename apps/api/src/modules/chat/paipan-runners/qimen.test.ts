import { describe, expect, it } from 'vitest';

import { runQimenPaipan, type QimenPaipanResult } from './qimen.js';

async function runPaipan(
  input: Record<string, unknown> = {},
): Promise<QimenPaipanResult> {
  return runQimenPaipan({
    solarDate: '2026-04-17',
    hour: 14,
    minute: 30,
    ...input,
  });
}

describe('qimen-paipan reference alignment', () => {
  it('matches the reference qimen core pan data', async () => {
    const result = await runPaipan();

    expect(result.干支).toBe('丙午年壬辰月辛酉日乙未时');
    expect(result.旬首).toBe('甲午');
    expect(result.旬空).toMatchObject({
      年空: '寅卯',
      月空: '午未',
      日空: '子丑',
      时空: '辰巳',
    });
    expect(result.排局).toBe('阳七局下');
    expect(result.值符值使).toMatchObject({
      值符星宫: ['蓬', '乾'],
      值使门宫: ['休', '坤'],
    });
    expect(
      ['坎', '坤', '震', '巽', '中', '乾', '兑', '艮', '离'].map(
        (gong) => result.天盘[gong],
      ),
    ).toEqual(['己', '戊', '丁', '庚', '丙', '辛', '乙', '癸', '壬']);
    expect(
      ['坎', '坤', '震', '巽', '中', '乾', '兑', '艮', '离'].map(
        (gong) => result.地盘[gong],
      ),
    ).toEqual(['辛', '壬', '癸', '丁', '丙', '乙', '戊', '己', '庚']);
  });

  it('matches the reference qimen door star and god pan data', async () => {
    const result = await runPaipan();
    const palaceOrder = ['坎', '坤', '震', '巽', '中', '乾', '兑', '艮', '离'];

    expect(palaceOrder.map((gong) => result.门[gong] ?? '')).toEqual([
      '杜',
      '休',
      '死',
      '惊',
      '',
      '伤',
      '生',
      '景',
      '开',
    ]);
    expect(palaceOrder.map((gong) => result.星[gong] ?? '')).toEqual([
      '任',
      '柱',
      '辅',
      '英',
      '',
      '蓬',
      '心',
      '冲',
      '芮禽',
    ]);
    expect(palaceOrder.map((gong) => result.神[gong] ?? '')).toEqual([
      '蛇',
      '地',
      '合',
      '虎',
      '',
      '符',
      '天',
      '阴',
      '玄',
    ]);
  });

  it('matches the reference qimen yin seven pan data', async () => {
    const result = await runPaipan({
      solarDate: '2026-12-21',
      hour: 23,
      minute: 30,
    });
    const palaceOrder = ['坎', '坤', '震', '巽', '中', '乾', '兑', '艮', '离'];

    expect(result.干支).toBe('丙午年庚子月庚午日丙子时');
    expect(result.旬首).toBe('甲戌');
    expect(result.旬空).toMatchObject({
      年空: '寅卯',
      月空: '辰巳',
      日空: '戌亥',
      时空: '申酉',
    });
    expect(result.排局).toBe('阴七局中');
    expect(result.值符值使).toMatchObject({
      值符星宫: ['心', '离'],
      值使门宫: ['开', '巽'],
    });
    expect(palaceOrder.map((gong) => result.天盘[gong] ?? '')).toEqual([
      '辛',
      '丁',
      '癸',
      '戊',
      '庚',
      '壬',
      '乙',
      '丙',
      '己',
    ]);
    expect(palaceOrder.map((gong) => result.神[gong] ?? '')).toEqual([
      '虎',
      '天',
      '阴',
      '蛇',
      '',
      '玄',
      '地',
      '合',
      '符',
    ]);
  });

  it('matches the reference qimen yin five pan data', async () => {
    const result = await runPaipan({
      solarDate: '2025-07-07',
      hour: 6,
      minute: 0,
    });
    const palaceOrder = ['坎', '坤', '震', '巽', '中', '乾', '兑', '艮', '离'];

    expect(result.干支).toBe('乙巳年癸未月丁丑日癸卯时');
    expect(result.旬首).toBe('甲午');
    expect(result.旬空).toMatchObject({
      年空: '寅卯',
      月空: '申酉',
      日空: '申酉',
      时空: '辰巳',
    });
    expect(result.排局).toBe('阴五局下');
    expect(result.值符值使).toMatchObject({
      值符星宫: ['芮', '离'],
      值使门宫: ['死', '坤'],
    });
    expect(palaceOrder.map((gong) => result.门[gong] ?? '')).toEqual([
      '休',
      '死',
      '伤',
      '杜',
      '',
      '开',
      '惊',
      '生',
      '景',
    ]);
    expect(palaceOrder.map((gong) => result.星[gong] ?? '')).toEqual([
      '任',
      '柱',
      '辅',
      '英',
      '',
      '蓬',
      '心',
      '冲',
      '芮禽',
    ]);
    expect(palaceOrder.map((gong) => result.神[gong] ?? '')).toEqual([
      '虎',
      '天',
      '阴',
      '蛇',
      '',
      '玄',
      '地',
      '合',
      '符',
    ]);
  });
});
