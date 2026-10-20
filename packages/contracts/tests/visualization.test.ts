import { describe, expect, it } from 'vitest';
import {
  parseVisualizationInput,
  visualizationReferences,
  visualizationReference,
} from '../src/visualization/index.js';

describe('visualization contract', () => {
  it('accepts diagrams and inline chart data without inventing values', () => {
    expect(
      parseVisualizationInput({
        type: 'mermaid',
        title: '解读流程',
        summary: '先看盘面，再核对依据。',
        spec: 'flowchart LR\n  A[盘面] --> B[依据]',
      }),
    ).toMatchObject({ ok: true, value: { type: 'mermaid' } });
    expect(
      parseVisualizationInput({
        type: 'vega-lite',
        title: '分布',
        summary: '来自已计算的数量。',
        spec: {
          data: { values: [{ element: '木', count: 2 }] },
          mark: 'bar',
          params: [
            {
              name: 'minimum',
              value: 0,
              bind: { input: 'range', min: 0, max: 5 },
            },
          ],
          transform: [{ filter: 'datum.count >= minimum' }],
          encoding: {
            x: { field: 'element', type: 'nominal' },
            y: { field: 'count', type: 'quantitative' },
          },
        },
      }),
    ).toMatchObject({ ok: true, value: { type: 'vega-lite' } });
  });

  it.each([
    {
      type: 'vega-lite',
      spec: {
        data: { values: [] },
        mark: 'bar',
        transform: [{ fold: ['a', 'b'] }],
      },
    },
    {
      type: 'vega-lite',
      spec: { data: { values: [] }, mark: 'bar', height: { step: 100000000 } },
    },
    {
      type: 'mermaid',
      spec: '%%{init: {"securityLevel":"loose"}}%%\nflowchart LR\nA-->B',
    },
    {
      type: 'mermaid',
      spec: 'flowchart LR\nA-->B\nclick A "https://example.test"',
    },
    {
      type: 'vega-lite',
      spec: { data: { url: 'https://example.test/data' }, mark: 'bar' },
    },
    { type: 'vega-lite', spec: { data: { values: [] }, mark: 'image' } },
    {
      type: 'vega-lite',
      spec: {
        data: { values: [] },
        mark: 'point',
        encoding: { href: { value: 'javascript:alert(1)' } },
      },
    },
    {
      type: 'vega-lite',
      spec: {
        data: { values: [] },
        mark: { type: 'bar', fill: 'url(https://example.test)' },
      },
    },
    {
      type: 'vega-lite',
      spec: {
        data: { values: [] },
        mark: 'bar',
        transform: [{ calculate: 'sequence(1, 100000000)', as: 'large' }],
      },
    },
    {
      type: 'vega-lite',
      spec: {
        data: { values: [] },
        mark: 'bar',
        params: [{ name: 'x', bind: { element: '#outside', input: 'range' } }],
      },
    },
    {
      type: 'vega-lite',
      spec: {
        data: { values: Array.from({ length: 1001 }, () => ({ x: 1 })) },
        mark: 'point',
      },
    },
  ])('rejects capabilities outside the rendering contract: $type', (input) => {
    expect(
      parseVisualizationInput({ title: '图形', summary: '摘要', ...input }).ok,
    ).toBe(false);
  });

  it('extracts ordered references without interpreting quoted code examples', () => {
    const id = `visualization-${'a'.repeat(64)}`;
    const reference = visualizationReference(id);
    expect(visualizationReferences(`说明\n\n${reference}\n\n继续解释`)).toEqual(
      [id],
    );
    expect(
      visualizationReferences(`\`\`\`\`markdown\n${reference}\n\`\`\`\``),
    ).toEqual([]);
    expect(
      visualizationReferences(`\`\`\`visualization\n${id.slice(0, -1)}`),
    ).toEqual([]);
  });
});
