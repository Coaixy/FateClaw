import { describe, expect, it } from 'vitest';
import { getArtifactHeightBudget } from '@/components/chat/artifact-layout';

const viewport = {
  height: 600,
  top: 100,
  paddingTop: 12,
  paddingBottom: 12,
  borderTop: 1,
  scrollTop: 0,
};

describe('artifact height budget', () => {
  it('keeps a chat chart stable when the conversation scrolls', () => {
    const initial = getArtifactHeightBudget(viewport);
    expect(getArtifactHeightBudget({ ...viewport, scrollTop: 800 })).toBe(
      initial,
    );
    expect(
      getArtifactHeightBudget({ ...viewport, top: 64, scrollTop: 1400 }),
    ).toBe(initial);
  });

  it('reserves preview content without making its chart shrink as the preview scrolls', () => {
    const initial = getArtifactHeightBudget(viewport, 221);
    const scrolled = getArtifactHeightBudget(
      { ...viewport, scrollTop: 80 },
      141,
    );
    expect(scrolled).toBe(initial);
    expect(initial).toBeLessThan(getArtifactHeightBudget(viewport));
  });

  it('reserves controls without forcing a minimum height on short screens', () => {
    for (const height of [640, 236, 120]) {
      const budget = getArtifactHeightBudget({ ...viewport, height });
      expect(budget).toBeGreaterThan(0);
      expect(
        budget + viewport.paddingTop + viewport.paddingBottom,
      ).toBeLessThan(height);
    }
  });
});
