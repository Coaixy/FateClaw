import { describe, expect, it } from 'vitest';

import {
  runIchingPaipan,
  type IchingPaipanResult,
} from '#modules/chat/paipan-runners/iching';

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
    expect(result.dayKong).toBe('子丑');
    expect(result.hourKong).toBe('辰巳');

    expect(result.benGua.guaName).toBe('既济');
    expect(result.zhiGua.guaName).toBe('随');
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
      '腾蛇',
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
    expect(result.benGua.yaoList[0]?.suiXian).toEqual({
      startAge: 20,
      endAge: 24,
    });
  });

  it('matches the iching-shifa fushen and shensha data', async () => {
    const result = await runPaipan();

    expect(result.benGua.fuShen).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fuLiuQin: '妻财',
          fuNaJia: '戊午',
          fuNaYin: '天上火',
          hostPosition: 3,
        }),
      ]),
    );
    expect(result.shenSha).toMatchObject({
      文昌: ['子'],
      驿马: ['亥'],
      桃花: ['午'],
      天喜: ['戌'],
      天医: ['卯'],
      天马: ['戌'],
      华盖: ['丑'],
      禄神: ['酉'],
      天乙贵人: ['午', '寅'],
    });
  });

  it('matches the iching-shifa data for all-moving kun to qian', async () => {
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
    expect([result.dayKong, result.hourKong]).toEqual(['寅卯', '戌亥']);
    expect(result.benGua.guaName).toBe('坤');
    expect(result.zhiGua.guaName).toBe('乾');
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
      文昌: ['巳'],
      驿马: ['寅'],
      桃花: ['酉'],
      华盖: ['辰'],
      禄神: ['寅'],
      天乙贵人: ['丑', '未'],
    });
    expect(result.benGua.yaoList[0]?.suiXian).toEqual({
      startAge: 29,
      endAge: 33,
    });
  });

  it('keeps changed gua liuqin based on the original gua palace wuxing', async () => {
    const result = await runPaipan({
      yao: '988897',
      datetime: '2026-05-30 17:30',
    });

    expect(result.benGua.guaName).toBe('益');
    expect(result.benGua.palace).toBe('巽');
    expect(result.benGua.palaceWuXing).toBe('木');
    expect(result.zhiGua.guaName).toBe('剥');
    expect(result.zhiGua.yaoList.map((yao) => yao.liuQin)).toEqual([
      '妻财',
      '子孙',
      '兄弟',
      '妻财',
      '父母',
      '兄弟',
    ]);
  });

  it('matches the iching-shifa data for static qian', async () => {
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
    expect([result.dayKong, result.hourKong]).toEqual(['戌亥', '辰巳']);
    expect(result.benGua.guaName).toBe('乾');
    expect(result.zhiGua.guaName).toBe('乾');
    expect(result.benGua.yaoList.map((yao) => yao.liuQin)).toEqual([
      '子孙',
      '妻财',
      '父母',
      '官鬼',
      '兄弟',
      '父母',
    ]);
    expect(result.shenSha).toMatchObject({
      文昌: ['子'],
      驿马: ['巳'],
      桃花: ['子'],
      天医: ['亥'],
      天马: ['寅'],
      天乙贵人: ['午', '寅'],
    });
  });
});
