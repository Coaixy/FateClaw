import { describe, expect, it } from 'vitest';

import { buildMatcher } from '../src/pi-runtime/tools/skill-grep-search.js';

describe('skill grep matcher', () => {
  it('matches normal short lines by regex', () => {
    const { matcher, usedRegex } = buildMatcher('foo', true, false);
    expect(usedRegex).toBe(true);
    expect(matcher('this line has foo in it')).toBeGreaterThanOrEqual(0);
    expect(matcher('nothing to see here')).toBe(-1);
  });

  it('matches complete lines without losing suffixes or changing end anchors', () => {
    const { matcher } = buildMatcher('needle$', true, false);
    expect(matcher(`${'x'.repeat(4010)}needle`)).toBe(4010);

    const anchored = buildMatcher('^a+$', true, false).matcher;
    expect(anchored(`${'a'.repeat(4000)}!`)).toBe(-1);
  });
});
