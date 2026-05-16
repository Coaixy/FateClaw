import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

interface QimenPaipanResult {
  干支: string;
  旬首: string;
  旬空: Record<string, string>;
  排局: string;
  值符值使: {
    值符星宫: string[];
    值使门宫: string[];
  };
  天盘: Record<string, string>;
  地盘: Record<string, string>;
  门: Record<string, string>;
  星: Record<string, string>;
  神: Record<string, string>;
}

const scriptPath = fileURLToPath(new URL('./paipan.js', import.meta.url));

function runPaipan(input: Record<string, unknown> = {}): QimenPaipanResult {
  const stdout = execFileSync('node', [scriptPath], {
    encoding: 'utf8',
    input: JSON.stringify({
      solarDate: '2026-04-17',
      hour: 14,
      minute: 30,
      ...input,
    }),
  });

  return JSON.parse(stdout) as QimenPaipanResult;
}

describe('qimen-paipan reference alignment', () => {
  it('matches the reference qimen core pan data', () => {
    const result = runPaipan();

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
    expect(['坎', '坤', '震', '巽', '中', '乾', '兑', '艮', '离'].map((gong) => result.天盘[gong]))
      .toEqual(['己', '戊', '丁', '庚', '丙', '辛', '乙', '癸', '壬']);
    expect(['坎', '坤', '震', '巽', '中', '乾', '兑', '艮', '离'].map((gong) => result.地盘[gong]))
      .toEqual(['辛', '壬', '癸', '丁', '丙', '乙', '戊', '己', '庚']);
  });

  it('matches the reference qimen door star and god pan data', () => {
    const result = runPaipan();
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

  it('matches the reference qimen yin seven pan data', () => {
    const result = runPaipan({
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

  it('matches the reference qimen yin five pan data', () => {
    const result = runPaipan({
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
