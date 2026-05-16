import { describe, expect, it } from 'vitest';

import { BoardFormatError, formatBoardForAi } from './index.js';

function makeLiuyao(
  position: number,
  yaoValue: number,
  isMoving = false,
  naYin?: string,
) {
  return {
    position,
    yaoValue,
    isMoving,
    tianGan: '己',
    diZhi: ['卯', '巳', '未', '酉', '亥', '丑'][position - 1],
    wuXing: ['木', '火', '土', '金', '水', '土'][position - 1],
    liuQin: ['子孙', '妻财', '官鬼', '父母', '兄弟', '子孙'][position - 1],
    liuShou: ['青龙', '朱雀', '勾陈', '螣蛇', '白虎', '玄武'][position - 1],
    shiYing: position === 1 ? '世' : position === 4 ? '应' : '',
    naYin,
  };
}

function makeBaziPillar(sixtyCycle: string, tenStar: string) {
  return {
    sixtyCycle,
    tenStar,
    heavenStem: { name: sixtyCycle[0], element: '木', yinYang: '阳' },
    earthBranch: {
      name: sixtyCycle[1],
      element: '水',
      hideHeavenStems: [{ name: '癸', type: '正印', element: '水' }],
    },
    terrain: '长生',
    sound: '海中金',
  };
}

const liuyaoBoard = {
  method: 'manual',
  question: '测试问题',
  ganZhiYear: { gz: '丙午' },
  ganZhiMonth: { gz: '壬辰' },
  ganZhiDay: { gz: '辛酉' },
  ganZhiHour: { gz: '乙未' },
  dayKong: '子丑',
  hourKong: '辰巳',
  monthJian: '壬辰',
  dongYaoCount: 1,
  explanation: '这里不应输出取断规则',
  benGua: {
    guaName: '既济',
    palace: '坎',
    yaoList: Array.from({ length: 6 }, (_, index) =>
      makeLiuyao(
        index + 1,
        index === 2 ? 6 : 7,
        index === 2,
        ['城头土', '霹雳火', '平地木', '大驿土', '平地木', '霹雳火'][index],
      ),
    ),
    fuShen: [
      {
        fuLiuQin: '妻财',
        fuNaJia: '戊午',
        fuWuXing: '火',
        hostYaoIndex: 2,
        hostNaJia: '己亥',
        relation: '我尅',
      },
    ],
    pangFuShen: [
      {
        fuLiuQin: '兄弟',
        fuNaJia: '己亥',
        fuWuXing: '水',
        hostYaoIndex: 2,
        hostNaJia: '己亥',
        relation: '比和',
      },
    ],
  },
  zhiGua: {
    guaName: '随',
    palace: '震',
    yaoList: Array.from({ length: 6 }, (_, index) =>
      makeLiuyao(
        index + 1,
        7,
        false,
        ['壁上土', '松柏木', '白蜡金', '屋上土', '山下火', '天河水'][index],
      ),
    ),
  },
  shenSha: {
    驿马: {
      targetDiZhi: ['亥'],
      matches: [
        {
          guaKey: 'benGua',
          position: 3,
          diZhi: '亥',
          naJia: '己亥',
        },
      ],
    },
    文昌: '子',
  },
};

const baziBoard = {
  bazi: {
    birthTime: '1990-01-01 08:00',
    gender: '男',
    baziString: '庚午 丁丑 甲子 戊辰',
    pillars: {
      year: makeBaziPillar('庚午', '七杀'),
      month: makeBaziPillar('丁丑', '伤官'),
      day: makeBaziPillar('甲子', '日主'),
      hour: makeBaziPillar('戊辰', '偏财'),
    },
  },
};

function makeAnnual(year: number) {
  return {
    year,
    age: year - 1989,
    sixtyCycle: `GZ${year}`,
    tenStar: '正官',
    terrain: '长生',
  };
}

describe('board-formatters', () => {
  it('formats official liuyao JSON into compact AI text', () => {
    const text = formatBoardForAi({
      skill: 'iching-paipan',
      output: JSON.stringify(liuyaoBoard),
    });

    expect(text).toContain('【六爻排盘 AI摘要】');
    expect(text).toContain('#六爻');
    expect(text).toContain('卦: 既济/坎宫 -> 随/震宫');
    expect(text).toContain('纳音平地木');
    expect(text).toContain('三爻: 官鬼 己未土 纳音平地木');
    expect(text).toContain(
      '三爻: 官鬼 己未土 纳音平地木 (勾陈) 动化 官鬼 己未土 纳音白蜡金 伏神: 妻财 戊午火 (飞己亥)；旁伏: 兄弟 己亥水 (飞己亥)',
    );
    expect(text).toContain('神煞: 驿马-亥 命中本卦三爻己亥；文昌-子');
    expect(text).not.toContain('我尅');
    expect(text).not.toContain('取断规则');
    expect(text).not.toContain('\n伏神:');
    expect(text).not.toContain('"benGua"');
  });

  it('keeps fu shen on the zero-based host index even when hostNaJia points elsewhere', () => {
    const text = formatBoardForAi({
      skill: 'iching-paipan',
      output: JSON.stringify({
        ...liuyaoBoard,
        benGua: {
          ...liuyaoBoard.benGua,
          yaoList: liuyaoBoard.benGua.yaoList.map((yao, index) => ({
            ...yao,
            naJia: ['己卯', '己丑', '己亥', '戊申', '戊戌', '戊子'][index],
          })),
          fuShen: [
            {
              ...liuyaoBoard.benGua.fuShen[0],
              hostYaoIndex: 0,
              hostNaJia: '己亥',
            },
          ],
          pangFuShen: [],
        },
      }),
    });

    expect(text).toContain(
      '初爻: 子孙 己卯木 纳音城头土 (青龙) [世] 静爻 伏神: 妻财 戊午火 (飞己亥)',
    );
    expect(text).not.toContain(
      '三爻: 官鬼 己未土 纳音平地木 (勾陈) 动化 官鬼 己未土 纳音白蜡金 伏神: 妻财 戊午火 (飞己亥)',
    );
  });

  it('formats official bazi JSON into compact AI text', () => {
    const text = formatBoardForAi({
      skill: 'bazi-paipan',
      output: JSON.stringify(baziBoard),
    });

    expect(text).toContain('【八字排盘 AI摘要】');
    expect(text).toContain('#四柱');
    expect(text).toContain('#运限');
    expect(text).toContain('日主: 甲木阳');
    expect(text).toContain('年: 庚午');
    expect(text).not.toContain('"pillars"');
  });

  it('formats bazi annuals without dropping years', () => {
    const text = formatBoardForAi({
      skill: 'bazi-paipan',
      output: JSON.stringify({
        ...baziBoard,
        fortune: {
          annualStartYear: 1990,
          annualEndYear: 2096,
          currentAnnualYear: 2026,
          annuals: Array.from({ length: 107 }, (_, index) =>
            makeAnnual(1990 + index),
          ),
        },
      }),
    });

    expect(text).toContain('当前流年: 2026GZ2026');
    expect(text).toContain('流年: 1990GZ1990');
    expect(text).toContain('2021GZ2021');
    expect(text).toContain('2031GZ2031');
    expect(text).toContain('2096GZ2096');
  });

  it('throws on invalid official board structure instead of falling back to JSON', () => {
    expect(() =>
      formatBoardForAi({
        skill: 'iching-paipan',
        output: JSON.stringify({ board: '不是官方六爻结构' }),
      }),
    ).toThrow(BoardFormatError);
  });
});
