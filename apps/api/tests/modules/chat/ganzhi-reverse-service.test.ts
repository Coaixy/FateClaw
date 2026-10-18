import { describe, expect, it } from 'vitest';

import { reverseGanzhiForPaipan } from '#modules/chat/ganzhi-reverse-service';

describe('reverseGanzhiForPaipan', () => {
  it('returns a known Gregorian candidate from four pillars', () => {
    const result = reverseGanzhiForPaipan({
      year: '乙巳',
      month: '癸未',
      day: '丁丑',
      hour: '癸卯',
      startYear: 2025,
      endYear: 2025,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.mode).toBe('eight_char');
    expect(result.data.matches).toContainEqual(
      expect.objectContaining({
        year: 2025,
        month: 7,
        day: 7,
        hour: 6,
        minute: 0,
      }),
    );
  });

  it('rejects invalid pillar text', () => {
    const result = reverseGanzhiForPaipan({
      year: '甲丑',
      month: '癸未',
      day: '丁丑',
      startYear: 2025,
      endYear: 2025,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.statusCode).toBe(400);
  });

  it('limits the searched year span', () => {
    const result = reverseGanzhiForPaipan({
      year: '乙巳',
      month: '癸未',
      day: '丁丑',
      startYear: 1800,
      endYear: 2101,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.statusCode).toBe(400);
  });
});
