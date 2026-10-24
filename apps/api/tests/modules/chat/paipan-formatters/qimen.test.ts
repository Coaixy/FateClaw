import { describe, expect, it } from 'vitest';

import { formatQimenPaipan } from '#modules/chat/paipan-formatters/qimen';

describe('formatQimenPaipan', () => {
  it('includes the Mingfa center and dark branches without hosting its stems elsewhere', () => {
    const output = formatQimenPaipan({
      盘式: '鸣法',
      排盘方式: '拆补',
      值符值使: {},
      天盘: { 中: '甲', 坤: '乙' },
      地盘: { 中: '丙', 坤: '丁' },
      星: { 中: '禽', 坤: '芮' },
      门: { 中: '中', 坤: '死' },
      神: { 中: '常', 坤: '符' },
      暗干: { 中: '戊', 坤: '癸' },
      暗支: { 中: '子', 坤: '巳' },
    });

    expect(output).toContain('盘式：鸣法');
    expect(output).toContain(
      '中宫：神 太常、星 禽、门 中、天盘 甲、地盘 丙、暗干 戊、暗支 子',
    );
    expect(output).toContain(
      '坤宫：神 值符、星 芮、门 死、天盘 乙、地盘 丁、暗干 癸、暗支 巳',
    );
  });

  it('keeps rotating center data while carrying its stems to the hosted palaces', () => {
    const output = formatQimenPaipan({
      值符值使: {},
      天盘: {
        中: '乙',
        坤: '辛',
        兑: '癸',
      },
      地盘: {
        中: '乙',
        坤: '癸',
        兑: '己',
      },
      星: {
        坤: '英',
        兑: '芮禽',
      },
      门: {
        坤: '生',
        兑: '伤',
      },
      神: {
        坤: '符',
        兑: '蛇',
      },
      暗干: {
        中: '丁',
        坤: '戊',
        兑: '癸',
      },
    });

    expect(output).toContain(
      '【中宫原始数据】\n中宫：天盘 乙、地盘 乙、暗干 丁',
    );
    expect(output).toContain(
      '坤宫：神 值符、星 英、门 生、天盘 辛、地盘 乙癸、暗干 戊',
    );
    expect(output).toContain(
      '兑宫：神 腾蛇、星 芮禽、门 伤、天盘 乙癸、地盘 己、暗干 癸',
    );
  });

  it('includes the leadership, Tianyi, both nested growth planes and full auxiliary facts', () => {
    const output = formatQimenPaipan({
      盘式: '鸣法',
      值符值使: {
        值符天干: ['甲申', '庚'],
        值符星宫: ['芮', '艮'],
        值使门宫: ['死', '坤'],
      },
      天乙: '庚',
      长生运: {
        天盘: { 艮: { 天干: '庚', 长生: { 丑: '墓', 寅: '绝' } } },
        地盘: { 艮: { 天干: '癸', 长生: { 丑: '冠带', 寅: '沐浴' } } },
      },
      门迫: [{ 门: '伤', 宫: '坤', 门五行: '木', 宫五行: '土' }],
      击刑: [
        { 宫1: '甲申庚', 宫2: '艮', 类型: '击刑', 六仪: '庚', 落宫: '艮' },
      ],
    });

    expect(output).toContain('值符天干：甲申、庚');
    expect(output).toContain('值符星宫：天芮（艮宫）');
    expect(output).toContain('值使门宫：死门（坤宫）');
    expect(output).toContain('天乙：庚');
    expect(output).toContain('【长生运·天盘】\n艮宫（庚）：丑:墓、寅:绝');
    expect(output).toContain('【长生运·地盘】\n艮宫（癸）：丑:冠带、寅:沐浴');
    expect(output).toContain('坤宫：伤门迫（门五行:木、宫五行:土）');
    expect(output).toContain('艮宫：甲申庚击刑（六仪:庚）');
  });
});
