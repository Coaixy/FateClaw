import { describe, expect, it } from 'vitest';
import {
  parseSvgDiagram,
  parseVisualizationArtifact,
  parseVisualizationInput,
} from '../src/visualization/index.js';

const spec = `<svg viewBox="0 0 480 420" xmlns="http://www.w3.org/2000/svg">
  <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10Z" fill="var(--color-primary)"/></marker></defs>
  <g fill="var(--color-surface-soft)" stroke="var(--color-primary)">
    <circle cx="100" cy="90" r="42"/><circle cx="365" cy="90" r="42"/>
    <path d="M150 90H310" marker-end="url(#arrow)"/>
  </g>
  <text x="100" y="98" text-anchor="middle" fill="var(--color-ink)">木 &amp; 火</text>
</svg>`;

describe('SVG explanatory diagrams', () => {
  it('preserves a complete diagram across input validation and historical artifact parsing', () => {
    const input = {
      type: 'svg',
      title: '相生示意',
      summary: '关系示意，不代表个人强弱。',
      spec,
    };
    const result = parseVisualizationInput(input);
    expect(result).toEqual({ ok: true, value: input });
    expect(
      parseVisualizationArtifact({
        ...input,
        version: 1,
        id: `visualization-${'a'.repeat(64)}`,
      }),
    ).toEqual({ ...input, version: 1, id: `visualization-${'a'.repeat(64)}` });
    const parsed = parseSvgDiagram(spec);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.root.children).toContainEqual({
      tag: 'text',
      attributes: {
        x: '100',
        y: '98',
        'text-anchor': 'middle',
        fill: 'var(--color-ink)',
      },
      children: ['木 & 火'],
    });
  });

  it.each([
    '<script>alert(1)</script>',
    '<foreignObject><div>HTML</div></foreignObject>',
    '<image href="https://example.test/image.png"/>',
    '<use href="#outside"/>',
    '<animate attributeName="fill" values="red;blue"/>',
    '<style>text { fill: red }</style>',
    '<circle onload="alert(1)"/>',
    '<circle style="fill:red"/>',
    '<circle xmlns="http://www.w3.org/1999/xhtml"/>',
    '<circle fill="u&#114;l(https://example.test/image)"/>',
    '<circle fill="var(--outside)"/>',
    '<circle fill="url(#missing)"/>',
    '<circle id="arrow"/><path marker-end="url(#arrow)"/>',
    '<circle id="same"/><circle id="same"/>',
    '<text>未闭合',
    '<g>文本必须有 text 标签</g>',
  ])(
    'rejects active content, external resources and invalid local definitions: %s',
    (body) => {
      expect(
        parseSvgDiagram(`<svg viewBox="0 0 480 420">${body}</svg>`).ok,
      ).toBe(false);
    },
  );

  it.each([
    '<!DOCTYPE svg [<!ENTITY sample "value">]><svg viewBox="0 0 480 420"/>',
    '<?xml-stylesheet href="https://example.test/style.css"?><svg viewBox="0 0 480 420"/>',
    '<svg/>',
    '<svg viewBox="0 0 Infinity 420"/>',
    '<svg viewBox="0 0 480 0"/>',
    '<svg viewBox="0 0 100000 420"/>',
    '<svg viewBox="0 0 480 420"><svg viewBox="0 0 480 420"/></svg>',
    `<svg viewBox="0 0 480 420">${'<g>'.repeat(17)}${'</g>'.repeat(17)}</svg>`,
    `<svg viewBox="0 0 480 420">${'<circle/>'.repeat(501)}</svg>`,
    `<svg viewBox="0 0 480 420"><text>${'字'.repeat(22_000)}</text></svg>`,
  ])('bounds XML structure and canvas dimensions', (value) => {
    expect(parseSvgDiagram(value).ok).toBe(false);
  });
});
