import { describe, expect, it } from 'vitest';

import { runLiurenPaipan } from '#modules/chat/paipan-runners/liuren';

const ancientInput = {
  method: 'yuejiang',
  yueJiang: '亥',
  shiChen: '未',
  riGanZhi: '丁巳',
};

describe('liuren ancient charting', () => {
  it('uses the supplied branches without inventing a Gregorian date', async () => {
    const result = await runLiurenPaipan({ ...ancientInput, yueLing: '未' });

    expect(result.input).toEqual({
      mode: 'yuejiang',
      yueJiang: '亥',
      shiChen: '未',
      riGanZhi: '丁巳',
      yueLing: '未',
    });
    expect(result.dateInfo).toMatchObject({
      date: '',
      bazi: '-- -- 丁巳 丁未',
      yuejiang: '亥',
      tianma: '辰',
    });
    expect(result.tianDiPan.tianPan.wei).toBe('亥');
    expect(result.sanChuan.keTi).toBe('重审·从革');
  });

  it.each([
    { ...ancientInput, shiChen: undefined },
    { ...ancientInput, riGanZhi: '丁午' },
    { ...ancientInput, solarDate: '2026-06-02', hour: 12 },
  ])(
    'rejects incomplete, invalid or mixed ancient inputs: %j',
    async (input) => {
      await expect(runLiurenPaipan(input)).rejects.toThrow();
    },
  );
});
