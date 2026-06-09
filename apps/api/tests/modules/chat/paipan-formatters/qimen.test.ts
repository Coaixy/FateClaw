import { describe, expect, it } from 'vitest';

import { formatQimenPaipan } from '../../../../src/modules/chat/paipan-formatters/qimen.js';

describe('formatQimenPaipan', () => {
  it('omits center palace and carries center stems to their hosted palaces', () => {
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
        坤: '戊',
        兑: '癸',
      },
    });

    expect(output).not.toContain('中宫');
    expect(output).toContain(
      '坤宫：神 符、星 英、门 生、天盘 辛、地盘 乙癸、暗干 戊',
    );
    expect(output).toContain(
      '兑宫：神 蛇、星 芮禽、门 伤、天盘 乙癸、地盘 己、暗干 癸',
    );
  });
});
