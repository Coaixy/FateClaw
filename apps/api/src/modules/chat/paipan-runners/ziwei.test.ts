import { describe, expect, it } from 'vitest';

import { runZiweiPaipan } from './ziwei.js';

describe('ziwei-paipan mutagens', () => {
  it('returns natal, palace stem and annual mutagen data', async () => {
    const result = await runZiweiPaipan({
      solarDate: '1990-05-15',
      hour: 10,
      minute: 30,
      gender: '男',
    });

    const annual2026 = result.annualMutagens.find(
      (annual) => annual.year === 2026,
    );

    expect(result.annualMutagenStartYear).toBe(1990);
    expect(result.annualMutagenEndYear).toBeGreaterThanOrEqual(2114);
    expect(result.natalMutagens).toEqual([
      expect.objectContaining({
        mutagen: '化禄',
        star: '太阳',
        palace: '兄弟',
        palaceBranch: '亥',
      }),
      expect.objectContaining({
        mutagen: '化权',
        star: '武曲',
        palace: '夫妻',
        palaceBranch: '戌',
      }),
      expect.objectContaining({
        mutagen: '化科',
        star: '太阴',
        palace: '田宅',
        palaceBranch: '卯',
      }),
      expect.objectContaining({
        mutagen: '化忌',
        star: '天同',
        palace: '子女',
        palaceBranch: '酉',
      }),
    ]);
    expect(result.palaceMutagenFlights).toContainEqual(
      expect.objectContaining({
        sourcePalace: '命宫',
        sourceHeavenlyStem: '戊',
        mutagen: '化禄',
        star: '贪狼',
        targetPalace: '官禄',
        relations: ['飞入', '三方四正'],
      }),
    );
    expect(annual2026).toMatchObject({
      year: 2026,
      nominalAge: 37,
      heavenlyStem: '丙',
      earthlyBranch: '午',
      mutagens: [
        { label: '化禄', star: '天同' },
        { label: '化权', star: '天机' },
        { label: '化科', star: '文昌' },
        { label: '化忌', star: '廉贞' },
      ],
    });
  });
});
