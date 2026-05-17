import { afterEach, afterAll, describe, expect, it, vi } from 'vitest';

import { isDirectCliRun } from './cli-entry.js';

describe('isDirectCliRun', () => {
  const originalArgv = process.argv;
  const originalPlatform = process.platform;
  const platformSpy = vi.spyOn(process, 'platform', 'get');

  afterEach(() => {
    process.argv = originalArgv;
    platformSpy.mockReturnValue(originalPlatform);
  });

  afterAll(() => {
    platformSpy.mockRestore();
  });

  it('matches Windows file URLs against argv paths', () => {
    platformSpy.mockReturnValue('win32');
    process.argv = [
      'node',
      'C:\\apps\\FateClaw\\skills\\official\\bazi-paipan\\paipan.js',
    ];

    // Windows 下 import.meta.url 会是 file URL，不能直接拿 pathname 和 argv 比较。
    expect(
      isDirectCliRun(
        'file:///C:/apps/FateClaw/skills/official/bazi-paipan/paipan.js',
      ),
    ).toBe(true);
  });
});
