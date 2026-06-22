import { describe, expect, it } from 'vitest';

import { formatIchingPaipan } from '../../../../src/modules/chat/paipan-formatters/iching.js';
import { runIchingPaipan } from '../../../../src/modules/chat/paipan-runners/iching.js';

/**
 * 用真实排盘数据驱动 formatter:先跑 runner 得到结构化盘面,再经一次 JSON
 * 序列化往返(模拟 artifact 落库后再读出),最后喂给 formatter。
 */
async function format(input: Record<string, unknown>): Promise<string> {
  const pan = await runIchingPaipan({
    method: 'manual',
    datetime: '2026-04-17 14:30',
    ...input,
  });
  return formatIchingPaipan(JSON.parse(JSON.stringify(pan)));
}

describe('formatIchingPaipan 回头生克标记', () => {
  it('动爻变出克本爻之爻时标注回头克', async () => {
    // 既济→随:三爻 己亥(水) 动,变庚辰(土),土克水 → 回头克
    const output = await format({ yao: '789678' });
    expect(output).toContain('〔回头克〕');
  });

  it('动爻变出生本爻之爻时标注回头生', async () => {
    // 坤→乾(六爻全动):多爻为变爻回头相生,如二爻 巳(火) 化寅(木),木生火
    const output = await format({
      yao: '666666',
      datetime: '2024-08-08 09:15',
    });
    expect(output).toContain('〔回头生〕');
  });

  it('静卦不产生任何回头生克标记', async () => {
    // 乾为静卦,无动爻,无变卦关系
    const output = await format({ yao: '777777' });
    expect(output).not.toContain('回头');
  });

  it('比和且地支顺行时标注化进神', async () => {
    // 无妄→履:二爻 寅木 动,变卯木,寅→卯 顺行相邻 → 化进神
    const output = await format({ yao: '768777' });
    expect(output).toContain('〔化进神〕');
  });

  it('比和且地支逆行时标注化退神', async () => {
    // 履→无妄:二爻 卯木 动,变寅木,卯→寅 逆行相邻 → 化退神
    const output = await format({ yao: '798777' });
    expect(output).toContain('〔化退神〕');
  });
});
