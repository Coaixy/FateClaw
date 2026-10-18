import { describe, expect, it } from 'vitest';

import { formatZiweiPaipan } from '#modules/chat/paipan-formatters/ziwei';

describe('formatZiweiPaipan', () => {
  it('prints adjective and decorative stars in palace lines', () => {
    const output = formatZiweiPaipan({
      palaces: [
        {
          name: '福德',
          heavenlyStem: '戊',
          earthlyBranch: '寅',
          majorStars: [{ name: '紫微', brightness: '旺' }],
          minorStars: [{ name: '文昌' }],
          adjectiveStars: [{ name: '天厨' }, { name: '天月' }],
          changsheng12: '长生',
          boshi12: '飞廉',
          jiangqian12: '指背',
          suiqian12: '白虎',
        },
      ],
    });

    expect(output).toContain('【十二宫】');
    expect(output).toContain('主星 紫微（旺）');
    expect(output).toContain('辅星 文昌');
    expect(output).toContain('杂曜 天厨、天月');
    expect(output).toContain(
      '十二神 长生十二神 长生、博士十二神 飞廉、将前十二神 指背、岁前十二神 白虎',
    );
  });

  it('prints yearly mutagens when the artifact includes them', () => {
    const output = formatZiweiPaipan({
      solarDate: '1990-05-15',
      palaces: [],
      natalMutagens: [
        {
          mutagen: '化禄',
          star: '太阳',
          palace: '兄弟',
          palaceBranch: '亥',
          brightness: '陷',
        },
      ],
      palaceMutagenFlights: [
        {
          sourcePalace: '命宫',
          sourceBranch: '子',
          sourceHeavenlyStem: '戊',
          mutagen: '化禄',
          star: '贪狼',
          targetPalace: '官禄',
          targetBranch: '辰',
          targetMarkers: ['来因宫'],
          relations: ['飞入', '三方四正'],
        },
      ],
      annualMutagenStartYear: 2026,
      annualMutagenEndYear: 2026,
      annualMutagens: [
        {
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
        },
      ],
    });

    expect(output).toContain('【生年四化】');
    expect(output).toContain('化禄太阳 -> 兄弟宫（亥）（陷）');
    expect(output).toContain('【宫干飞化】');
    expect(output).toContain(
      '命宫（戊子）化禄贪狼 -> 官禄宫（辰、来因宫） [飞入、三方四正]',
    );
    expect(output).toContain('【流年四化】');
    expect(output).toContain('流年四化范围：2026-2026年');
    expect(output).toContain(
      '2026年（37岁） 丙午：化禄天同、化权天机、化科文昌、化忌廉贞',
    );
  });
});
