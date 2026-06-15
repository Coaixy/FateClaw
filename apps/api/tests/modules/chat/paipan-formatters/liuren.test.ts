import { describe, expect, it } from 'vitest';

import { formatLiurenPaipan } from '../../../../src/modules/chat/paipan-formatters/liuren.js';

describe('formatLiurenPaipan', () => {
  it('formats empty dun gan as kong and separates jian chu by sky branch', () => {
    const output = formatLiurenPaipan({
      dateInfo: {
        date: '2026-06-15 00:00',
      },
      siKe: {
        ke1: ['亥子', '玄武'],
      },
      sanChuan: {},
      tianDiPan: {
        tianJiang: {
          zi: '玄武',
        },
        tianPan: {
          zi: '亥',
        },
      },
      yinYangGuiRen: {
        yangGuiRen: {
          zi: '青龙',
        },
        yinGuiRen: {
          zi: '玄武',
        },
      },
      dunGan: {
        zi: '无',
        hai: '无',
      },
      jianChu: {
        zi: '执',
      },
      shenSha: [
        {
          name: '驿马',
          value: '申',
        },
      ],
    });

    expect(output).toContain('子宫：昼将：青龙、夜将：玄武、天盘：亥、遁干：空');
    expect(output).toContain('一课：上神：亥、下神：子、昼将：玄武、上神遁干：空');
    expect(output).not.toContain('子宫：天将：玄武');
    expect(output).not.toContain('建除：执');
    expect(output).toContain('【建除】\n亥：执');
    expect(output).toContain('【神煞】\n驿马：申');
    expect(output).not.toContain('驿马-申');
  });
});
