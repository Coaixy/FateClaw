import { describe, expect, it, vi } from 'vitest';

vi.mock('#infrastructure/db', () => ({
  getResolvedEnabledOfficialSkillNames: vi.fn(async () => [
    '八字排盘',
    '奇门遁甲排盘',
    '大六壬排盘',
  ]),
}));

import { executeDirectPaipan } from '#modules/chat/paipan-runtime';

describe('executeDirectPaipan', () => {
  it.each([
    {
      skillDir: 'qimen-paipan',
      input: { panType: '鸣法', solarDate: '2024-12-13', hour: 9, minute: 31 },
      artifact: { 盘式: '鸣法', 暗支: expect.any(Object) },
      text: '盘式：鸣法',
    },
    {
      skillDir: 'liuren-paipan',
      input: {
        method: 'yuejiang',
        yueJiang: '亥',
        shiChen: '未',
        riGanZhi: '丁巳',
      },
      artifact: {
        input: { mode: 'yuejiang', riGanZhi: '丁巳' },
        dateInfo: { date: '' },
      },
      text: '起课方式：古籍式',
    },
  ])(
    'preserves the selected method through catalog validation and saved context: $skillDir',
    async ({ skillDir, input, artifact, text }) => {
      const result = await executeDirectPaipan({
        accountId: 'web:user-1',
        userId: 'user-1',
        skillDir,
        input,
      });

      expect(result.skillContextEntry.artifactData).toMatchObject(artifact);
      expect(result.skillContextEntry.output).toContain(text);
    },
  );

  it.each([
    { method: 'yuejiang', yueJiang: '亥', shiChen: '未', riGanZhi: '丁午' },
    {
      method: 'yuejiang',
      yueJiang: '亥',
      shiChen: '未',
      riGanZhi: '丁巳',
      hour: 12,
    },
  ])(
    'reports invalid or mixed ancient inputs as parameter errors: %j',
    async (input) => {
      await expect(
        executeDirectPaipan({
          accountId: 'web:user-1',
          userId: 'user-1',
          skillDir: 'liuren-paipan',
          input,
        }),
      ).rejects.toMatchObject({
        code: 'PAIPAN.PARAM_INVALID',
        statusCode: 400,
      });
    },
  );

  it('keeps structured artifactData and stores formatter text as output', async () => {
    const result = await executeDirectPaipan({
      accountId: 'web:user-1',
      userId: 'user-1',
      skillDir: 'bazi-paipan',
      input: {
        solarDate: '1990-05-15',
        hour: 10,
        minute: 30,
        gender: '男',
        include: ['bazi'],
      },
    });

    expect(result.skillContextEntry.artifactData).toMatchObject({
      bazi: expect.objectContaining({
        baziString: '庚午 辛巳 庚辰 辛巳',
      }),
    });
    expect(result.skillContextEntry.output).toContain(
      '八字排盘（系统排盘结果）',
    );
    expect(result.skillContextEntry.output).toContain('【命盘概要】');
    expect(result.skillContextEntry.output).toContain(
      '四柱：庚午 辛巳 庚辰 辛巳',
    );
    expect(result.skillContextEntry.output).toContain('【四柱明细】');
    expect(result.skillContextEntry.output.trim().startsWith('{')).toBe(false);
  });

  it('rejects an out-of-range decadeCount instead of driving the underlying unbounded loop', async () => {
    // 回归防护：decadeCount 直接决定底层库 buildDecadeList / getAnnualFortuneRange 的循环次数，
    // 超限值必须在校验层被拒（不进 runner），否则单条免登录请求即可阻塞事件循环。
    await expect(
      executeDirectPaipan({
        accountId: 'web:user-1',
        userId: 'user-1',
        skillDir: 'bazi-paipan',
        input: {
          solarDate: '1990-05-15',
          hour: 10,
          gender: '男',
          decadeCount: 100000,
        },
      }),
    ).rejects.toMatchObject({
      code: 'PAIPAN.PARAM_INVALID',
      statusCode: 400,
    });
  });

  it('accepts an in-range decadeCount', async () => {
    const result = await executeDirectPaipan({
      accountId: 'web:user-1',
      userId: 'user-1',
      skillDir: 'bazi-paipan',
      input: {
        solarDate: '1990-05-15',
        hour: 10,
        gender: '男',
        decadeCount: 8,
        include: ['fortune'],
      },
    });
    expect(result.skillContextEntry.artifactData).toHaveProperty('fortune');
  });

  it('strips undeclared keys before dispatching to the runner', async () => {
    // 白名单剔除：schema 未声明的键不透传给底层库；带垃圾键的请求应正常完成。
    // 含原型链同名键（toString/constructor）——用 Object.hasOwn 判定后同样被剔除，
    // 不会被误判为「已声明」而抛出误导性 400（若用 properties[key] 真值判定则会）。
    const result = await executeDirectPaipan({
      accountId: 'web:user-1',
      userId: 'user-1',
      skillDir: 'bazi-paipan',
      input: {
        solarDate: '1990-05-15',
        hour: 10,
        gender: '男',
        include: ['bazi'],
        __proto_pollution: 'x',
        someUnknownKnob: 999999999,
        toString: 1,
        constructor: 'x',
      },
    });
    expect(result.skillContextEntry.artifactData).toMatchObject({
      bazi: expect.objectContaining({
        baziString: '庚午 辛巳 庚辰 辛巳',
      }),
    });
  });
});
