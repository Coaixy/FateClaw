import { describe, expect, it } from 'vitest';

import { truncateStringFields } from '../src/request-scope.js';

describe('request scope trace field truncation', () => {
  it('keeps truncated UTF-8 strings within the byte limit recursively', () => {
    const value = {
      mixed: `${'中'.repeat(2_000)}${'a'.repeat(5_000)}`,
      nested: [{ emoji: '😀'.repeat(2_000) }],
    };

    const truncated = truncateStringFields(value) as {
      mixed: string;
      nested: Array<{ emoji: string }>;
    };

    expect(Buffer.byteLength(truncated.mixed, 'utf8')).toBeLessThanOrEqual(
      4 * 1024,
    );
    expect(
      Buffer.byteLength(truncated.nested[0]?.emoji ?? '', 'utf8'),
    ).toBeLessThanOrEqual(4 * 1024);
    expect(truncated.mixed).toContain('[truncated ');
    expect(truncated.nested[0]?.emoji).toContain('[truncated ');
    expect(/[\uD800-\uDBFF]$/.test(truncated.nested[0]?.emoji ?? '')).toBe(
      false,
    );
  });
});
