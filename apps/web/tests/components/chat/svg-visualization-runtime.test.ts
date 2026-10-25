// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { mountVisualization } from '@/components/chat/visualization-runtime';
import type { VisualizationArtifact } from '@fateclaw/contracts/visualization';

const artifact: VisualizationArtifact = {
  id: `visualization-${'a'.repeat(64)}`,
  version: 1,
  type: 'svg',
  title: '五行关系',
  summary: '示意关系，不代表个人强弱。',
  spec: '<svg viewBox="0 0 480 420"><defs><marker id="arrow" viewBox="0 0 10 10" markerWidth="6" markerHeight="6"><path d="M0 0L10 5L0 10Z"/></marker></defs><path d="M100 100L200 200" marker-end="url(#arrow)"/><text x="100" y="100" fill="var(--color-ink)">木 &amp; 火</text></svg>',
};

afterEach(() => document.body.replaceChildren());

describe('SVG visualization mounts', () => {
  it('isolates definition IDs between copies and releases only its own figure', async () => {
    const hosts = [
      document.createElement('div'),
      document.createElement('div'),
    ];
    document.body.append(...hosts);
    const releases = await Promise.all(
      hosts.map((host) => mountVisualization(host, artifact, () => {})),
    );
    const markers = hosts.map((host) => host.querySelector('marker')!.id);
    expect(new Set(markers).size).toBe(2);
    for (let index = 0; index < hosts.length; index++) {
      const root = hosts[index].querySelector('svg')!;
      expect(root.getAttribute('width')).toBe('100%');
      expect(root.style.maxWidth).toBe('480px');
      expect(root.hasAttribute('height')).toBe(false);
      expect(root.getAttribute('aria-label')).toContain(artifact.summary);
      expect(
        root.querySelector('[marker-end]')!.getAttribute('marker-end'),
      ).toBe(`url(#${markers[index]})`);
      expect(root.querySelector('text')!.textContent).toBe('木 & 火');
      expect(root.querySelector('text')!.getAttribute('fill')).toBe(
        'var(--color-ink)',
      );
    }
    releases[0]();
    expect(hosts[0].childElementCount).toBe(0);
    expect(hosts[1].querySelector('marker')!.id).toBe(markers[1]);
    releases[1]();
  });

  it('uses the embedded conversation font instead of the admin document font', async () => {
    const host = document.createElement('div');
    host.style.setProperty('--font-sans', 'KaiTi, serif');
    document.body.append(host);

    const release = await mountVisualization(host, artifact, () => {});

    expect(host.querySelector('svg')!.style.fontFamily).toBe('KaiTi, serif');
    release();
  });

  it('revalidates untrusted historical markup before creating any DOM nodes', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    await expect(
      mountVisualization(
        host,
        {
          ...artifact,
          spec: '<svg viewBox="0 0 480 420"><foreignObject><img src="https://example.test/image"/></foreignObject></svg>',
        },
        () => {},
      ),
    ).rejects.toThrow();
    expect(host.childElementCount).toBe(0);
  });
});
