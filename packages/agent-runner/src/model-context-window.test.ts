import { describe, expect, it } from 'vitest';

import { getContextWindowForModel } from './model-context-window.js';

describe('getContextWindowForModel', () => {
  it('reads the shared context window table', () => {
    expect(getContextWindowForModel('gpt-5.5')).toBe(1_050_000);
    expect(getContextWindowForModel('gpt-5.5-pro')).toBe(1_050_000);
    expect(getContextWindowForModel('gpt-5.4')).toBe(1_050_000);
    expect(getContextWindowForModel('gpt-5')).toBe(400_000);
    expect(getContextWindowForModel('claude-opus-4.7')).toBe(1_000_000);
    expect(getContextWindowForModel('gemini-3.1-pro')).toBe(1_000_000);
    expect(getContextWindowForModel('qwen3.6-plus')).toBe(1_000_000);
    expect(getContextWindowForModel('qwen3-max')).toBe(262_144);
    expect(getContextWindowForModel('doubao-2')).toBe(256_000);
    expect(getContextWindowForModel('doubao-1-5-pro-32k')).toBe(32_000);
    expect(getContextWindowForModel('kimi-k2.6')).toBe(256_000);
    expect(getContextWindowForModel('glm-4.6')).toBe(200_000);
    expect(getContextWindowForModel('hunyuan-turbos')).toBe(32_000);
    expect(getContextWindowForModel('ernie-4.5')).toBe(128_000);
  });

  it('uses the same conservative fallback for unknown models', () => {
    expect(getContextWindowForModel('unknown-model')).toBe(128_000);
  });
});
