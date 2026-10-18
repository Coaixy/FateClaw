import { describe, expect, it } from 'vitest';

import { runJingzhanPaipan } from '#modules/chat/paipan-runners/jingzhan';

describe('runJingzhanPaipan 高岛易断解读', () => {
  it('略筮法起卦附带高岛易断解读，卦名与动爻数均对齐本卦', async () => {
    const result = await runJingzhanPaipan({ method: 'lueshifa' });

    expect(result.gaoDaoYiDuan).toBeDefined();
    expect(result.gaoDaoYiDuan?.guaName).toBe(result.benGua.guaName);
    const movingCount = result.benGua.yaoList.filter(
      (yao) => yao.isMoving,
    ).length;
    expect(result.gaoDaoYiDuan?.movingLines).toHaveLength(movingCount);
  });

  it('非略筮法起卦不附带高岛易断解读', async () => {
    const result = await runJingzhanPaipan({
      method: 'manual',
      yao: '789678',
      datetime: '2026-04-17 14:30',
    });

    expect(result.gaoDaoYiDuan).toBeUndefined();
  });
});
