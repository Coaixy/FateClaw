import { describe, expect, it, vi } from 'vitest';

vi.mock('../../infrastructure/db.js', () => ({
  getResolvedEnabledOfficialSkillNames: vi.fn(async () => ['八字排盘']),
}));

import { executeDirectPaipan } from './paipan-runtime.js';

describe('executeDirectPaipan', () => {
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
    expect(result.skillContextEntry.output).toContain(
      'baziString：庚午 辛巳 庚辰 辛巳',
    );
    expect(result.skillContextEntry.output.trim().startsWith('{')).toBe(false);
  });
});
