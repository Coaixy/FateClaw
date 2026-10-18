import { describe, expect, it } from 'vitest';

import { formatJingzhanPaipan } from '#modules/chat/paipan-formatters/jingzhan';
import { runJingzhanPaipan } from '#modules/chat/paipan-runners/jingzhan';

describe('formatJingzhanPaipan 高岛易断解读小节', () => {
  it('存在 gaoDaoYiDuan 时输出本卦总论与逐条动爻详解', async () => {
    const pan = await runJingzhanPaipan({
      method: 'manual',
      yao: '789678',
      datetime: '2026-04-17 14:30',
    });
    const withGaoDaoYiDuan = {
      ...JSON.parse(JSON.stringify(pan)),
      gaoDaoYiDuan: {
        guaName: '既济',
        intro: '既济卦总论示例',
        movingLines: [
          {
            line: 3,
            title: '九三：高宗伐鬼方，三年克之，小人勿用。',
            xiang: '象曰：三年克之，惫也。',
            commentary: '逐句详解示例',
          },
        ],
      },
    };

    const output = formatJingzhanPaipan(withGaoDaoYiDuan);

    expect(output).toContain('【高岛易断解读】');
    expect(output).toContain('本卦总论：既济卦总论示例');
    expect(output).toContain('三爻辞：九三：高宗伐鬼方，三年克之，小人勿用。');
    expect(output).toContain('三爻象：象曰：三年克之，惫也。');
    expect(output).toContain('三爻详解：逐句详解示例');
  });

  it('不存在 gaoDaoYiDuan 时不输出该小节（如大衍筮法等起卦方式）', async () => {
    const pan = await runJingzhanPaipan({
      method: 'manual',
      yao: '789678',
      datetime: '2026-04-17 14:30',
    });

    const output = formatJingzhanPaipan(JSON.parse(JSON.stringify(pan)));

    expect(output).not.toContain('【高岛易断解读】');
  });
});
