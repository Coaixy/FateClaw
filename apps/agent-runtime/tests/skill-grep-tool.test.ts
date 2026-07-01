import { describe, expect, it } from 'vitest';

import { __buildMatcherForTests } from '../src/pi-runtime/tools/skill-grep-tool.js';

describe('skill grep matcher', () => {
  it('matches normal short lines by regex', () => {
    const { matcher, usedRegex } = __buildMatcherForTests('foo', true, false);
    expect(usedRegex).toBe(true);
    expect(matcher('this line has foo in it')).toBeGreaterThanOrEqual(0);
    expect(matcher('nothing to see here')).toBe(-1);
  });

  it('caps regex matching to the first 4000 chars of an overlong line', () => {
    const CAP = 4000;
    const { matcher } = __buildMatcherForTests('needle', true, false);
    const withinCap = `${'x'.repeat(CAP - 10)}needle${'y'.repeat(50)}`;
    const beyondCap = `${'x'.repeat(CAP + 10)}needle`;

    expect(matcher(withinCap)).toBeGreaterThanOrEqual(0);
    expect(matcher(beyondCap)).toBe(-1);
  });
});
