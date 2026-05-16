import { describe, expect, it } from 'vitest';

import { getContextWindow } from './model-context-window.js';

describe('getContextWindow', () => {
  it('matches the shared context window table', () => {
    expect(getContextWindow('gpt-5.5')).toBe(1_050_000);
    expect(getContextWindow('gpt-5.5-pro')).toBe(1_050_000);
    expect(getContextWindow('gpt-5.4')).toBe(1_050_000);
    expect(getContextWindow('gpt-5.4-pro')).toBe(1_050_000);
    expect(getContextWindow('gpt-5')).toBe(400_000);
    expect(getContextWindow('claude-sonnet-4-20250514')).toBe(1_000_000);
    expect(getContextWindow('gemini-3.1-pro-preview')).toBe(1_000_000);
    expect(getContextWindow('deepseek-reasoner')).toBe(1_000_000);
    expect(getContextWindow('qwen-plus-2025-05')).toBe(1_000_000);
    expect(getContextWindow('qwen3.6')).toBe(262_144);
    expect(getContextWindow('doubao-seed-2-0')).toBe(256_000);
    expect(getContextWindow('doubao-1-5-pro-32k')).toBe(32_000);
    expect(getContextWindow('kimi-k2.5')).toBe(256_000);
    expect(getContextWindow('glm-4.7')).toBe(200_000);
    expect(getContextWindow('hunyuan-standard-256k')).toBe(256_000);
    expect(getContextWindow('hunyuan-t1')).toBe(32_000);
    expect(getContextWindow('ernie-5.0-thinking')).toBe(128_000);
  });

  it('keeps a conservative fallback for unknown models', () => {
    expect(getContextWindow('unknown-model')).toBe(128_000);
  });
});
