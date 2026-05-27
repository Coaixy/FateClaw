import { describe, expect, it } from 'vitest';

import { runIchingPaipan, type IchingPaipanResult } from './iching.js';

async function runPaipan(
  input: Record<string, unknown> = {},
): Promise<IchingPaipanResult> {
  return runIchingPaipan({
    method: 'manual',
    yao: '789678',
    datetime: '2026-04-17 14:30',
    ...input,
  });
}

describe('iching-paipan reference alignment', () => {
  it('matches the reference liuyao pillars and gua data', async () => {
    const result = await runPaipan();

    expect([
      result.ganZhiYear.gz,
      result.ganZhiMonth.gz,
      result.ganZhiDay.gz,
      result.ganZhiHour.gz,
    ]).toEqual(['丙午', '壬辰', '辛酉', '乙未']);
    expect(result.yearKong).toBe('寅卯');
    expect(result.monthKong).toBe('午未');
    expect(result.dayKong).toBe('子丑');
    expect(result.hourKong).toBe('辰巳');

    expect(result.benGua.guaName).toBe('水火既济');
    expect(result.zhiGua.guaName).toBe('泽雷随');
    expect(result.zhiGua.guaName).not.toBe('随为随');
    expect(result.benGua.yaoList.map((yao) => yao.naJia)).toEqual([
      '己卯',
      '己丑',
      '己亥',
      '戊申',
      '戊戌',
      '戊子',
    ]);
    expect(result.benGua.yaoList.map((yao) => yao.liuQin)).toEqual([
      '子孙',
      '官鬼',
      '兄弟',
      '父母',
      '官鬼',
      '兄弟',
    ]);
    expect(result.benGua.yaoList.map((yao) => yao.liuShou)).toEqual([
      '白虎',
      '玄武',
      '青龙',
      '朱雀',
      '勾陈',
      '螣蛇',
    ]);
    expect(result.zhiGua.yaoList.map((yao) => yao.naJia)).toEqual([
      '庚子',
      '庚寅',
      '庚辰',
      '丁亥',
      '丁酉',
      '丁未',
    ]);
    expect(result.zhiGua.yaoList.map((yao) => yao.liuQin)).toEqual([
      '兄弟',
      '子孙',
      '官鬼',
      '兄弟',
      '父母',
      '官鬼',
    ]);
  });

  it('matches the reference fushen and shensha data', async () => {
    const result = await runPaipan();

    expect(result.benGua.fuShen).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fuLiuQin: '妻财',
          hostYaoIndex: 2,
          hostNaJia: '己亥',
        }),
      ]),
    );
    expect(result.shenSha).toMatchObject({
      文昌: '子',
      驿马: '亥',
      将星: '',
      桃花: '午',
      天喜: '戌',
      天医: '卯',
      谋星: '未',
      华盖: '',
      灾煞: '卯',
      劫煞: '寅',
      禄神: '酉',
      阳刃: '申',
    });
  });

  it('matches the reference data for all-moving kun to qian', async () => {
    const result = await runPaipan({
      yao: '666666',
      datetime: '2024-08-08 09:15',
    });

    expect([
      result.ganZhiYear.gz,
      result.ganZhiMonth.gz,
      result.ganZhiDay.gz,
      result.ganZhiHour.gz,
    ]).toEqual(['甲辰', '壬申', '甲辰', '己巳']);
    expect([
      result.yearKong,
      result.monthKong,
      result.dayKong,
      result.hourKong,
    ]).toEqual(['寅卯', '戌亥', '寅卯', '戌亥']);
    expect(result.benGua.guaName).toBe('坤为地');
    expect(result.zhiGua.guaName).toBe('乾为天');
    expect(result.benGua.yaoList.map((yao) => yao.naJia)).toEqual([
      '乙未',
      '乙巳',
      '乙卯',
      '癸丑',
      '癸亥',
      '癸酉',
    ]);
    expect(result.zhiGua.yaoList.map((yao) => yao.liuQin)).toEqual([
      '妻财',
      '官鬼',
      '兄弟',
      '父母',
      '子孙',
      '兄弟',
    ]);
    expect(result.shenSha).toMatchObject({
      文昌: '巳',
      驿马: '寅',
      桃花: '酉',
      华盖: '辰',
      禄神: '寅',
      阳刃: '卯',
    });
  });

  it('matches the reference data for static qian', async () => {
    const result = await runPaipan({
      yao: '777777',
      datetime: '2025-01-02 22:05',
    });

    expect([
      result.ganZhiYear.gz,
      result.ganZhiMonth.gz,
      result.ganZhiDay.gz,
      result.ganZhiHour.gz,
    ]).toEqual(['甲辰', '丙子', '辛未', '己亥']);
    expect([
      result.yearKong,
      result.monthKong,
      result.dayKong,
      result.hourKong,
    ]).toEqual(['寅卯', '申酉', '戌亥', '辰巳']);
    expect(result.benGua.guaName).toBe('乾为天');
    expect(result.zhiGua.guaName).toBe('乾为天');
    expect(result.benGua.yaoList.map((yao) => yao.liuQin)).toEqual([
      '子孙',
      '妻财',
      '父母',
      '官鬼',
      '兄弟',
      '父母',
    ]);
    expect(result.shenSha).toMatchObject({
      文昌: '子',
      驿马: '巳',
      将星: '子',
      桃花: '子',
      天医: '亥',
      劫煞: '申',
    });
  });
});
