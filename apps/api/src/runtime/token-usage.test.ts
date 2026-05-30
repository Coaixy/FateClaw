import { describe, expect, it } from 'vitest';

import { normalizeRuntimeTokenUsage } from './token-usage.js';

describe('normalizeRuntimeTokenUsage', () => {
  it('adds total-only cache tokens into input tokens', () => {
    expect(
      normalizeRuntimeTokenUsage({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 20,
      }),
    ).toEqual({
      promptTokens: 15,
      completionTokens: 5,
      totalTokens: 20,
    });
  });

  it('treats total-only usage as input tokens', () => {
    expect(normalizeRuntimeTokenUsage({ totalTokens: 20 })).toEqual({
      promptTokens: 20,
      completionTokens: 0,
      totalTokens: 20,
    });
  });

  it('adds explicit cache tokens when provider total is missing', () => {
    expect(
      normalizeRuntimeTokenUsage({
        promptTokens: 10,
        completionTokens: 5,
        cacheRead: 3,
        cacheWrite: 2,
      }),
    ).toEqual({
      promptTokens: 15,
      completionTokens: 5,
      totalTokens: 20,
    });
  });

  it('keeps split totals when provider total is missing', () => {
    expect(
      normalizeRuntimeTokenUsage({
        promptTokens: 7,
        completionTokens: 3,
      }),
    ).toEqual({
      promptTokens: 7,
      completionTokens: 3,
      totalTokens: 10,
    });
  });
});
