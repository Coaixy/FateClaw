import type { VisualizationArtifact } from '@fateclaw/contracts/visualization';
import type { TopLevelSpec } from 'vega-lite';

let mermaidQueue: Promise<unknown> = Promise.resolve();
let renderSequence = 0;

export async function mountVisualization(
  host: HTMLElement,
  artifact: VisualizationArtifact,
  onError: () => void,
): Promise<() => void> {
  const style = getComputedStyle(document.documentElement);
  const ink = style.getPropertyValue('--color-ink').trim() || '#141413';
  const muted = style.getPropertyValue('--color-muted').trim() || '#6c6a64';
  const border = style.getPropertyValue('--color-hairline').trim() || '#e6dfd8';
  const surface =
    style.getPropertyValue('--color-surface-soft').trim() || '#f5f0e8';
  const primary = style.getPropertyValue('--color-primary').trim() || '#cc785c';
  const font =
    style.getPropertyValue('--font-sans').trim() || 'system-ui, sans-serif';
  if (artifact.type === 'mermaid') {
    const render = async () => {
      const { default: mermaid } = await import('mermaid');
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        htmlLabels: false,
        maxTextSize: 16_000,
        maxEdges: 200,
        suppressErrorRendering: true,
        secure: [
          'secure',
          'securityLevel',
          'startOnLoad',
          'maxTextSize',
          'maxEdges',
          'htmlLabels',
          'themeCSS',
        ],
        theme: 'base',
        fontFamily: font,
        themeVariables: {
          primaryColor: surface,
          primaryTextColor: ink,
          primaryBorderColor: primary,
          lineColor: muted,
          secondaryColor: surface,
          tertiaryColor: surface,
          background: surface,
          mainBkg: surface,
          textColor: ink,
          nodeTextColor: ink,
        },
      });
      const { svg } = await mermaid.render(
        `fateclaw-visual-${++renderSequence}`,
        artifact.spec,
      );
      const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
      const root = document.documentElement;
      if (root.localName !== 'svg' || document.querySelector('parsererror'))
        throw new Error('Invalid diagram output');
      root.setAttribute('width', '100%');
      root.removeAttribute('height');
      root.style.maxWidth = '100%';
      root.style.height = 'auto';
      host.replaceChildren(host.ownerDocument.importNode(root, true));
    };
    // Mermaid configuration is global; serialize initialization with the matching render.
    const task = mermaidQueue.then(render, render);
    mermaidQueue = task.catch(() => {});
    await task;
    return () => host.replaceChildren();
  }

  const [vega, vegaLite, { expressionInterpreter }] = await Promise.all([
    import('vega'),
    import('vega-lite'),
    import('vega-interpreter'),
  ]);
  const loader = vega.loader();
  loader.load = async () => {
    throw new Error('External visualization resources are disabled');
  };
  loader.sanitize = async () => {
    throw new Error('Visualization links are disabled');
  };
  const logger = vega.logger(vega.None);
  const spec = vegaLite.compile(
    {
      ...artifact.spec,
      width: 'container',
      height: artifact.spec.height ?? 280,
      autosize: { type: 'fit', contains: 'padding', resize: true },
      config: {
        background: 'transparent',
        font,
        axis: {
          labelColor: muted,
          titleColor: ink,
          domainColor: border,
          tickColor: border,
          gridColor: border,
          labelFontSize: 12,
          titleFontSize: 13,
        },
        legend: { labelColor: muted, titleColor: ink, labelFontSize: 12 },
        title: { color: ink },
        range: {
          category: [
            primary,
            '#5db8a6',
            '#c8983a',
            '#5a9fc0',
            '#8b6b45',
            '#4f8f66',
          ],
        },
        mark: { color: primary },
        view: { stroke: null },
      },
    } as unknown as TopLevelSpec,
    { logger },
  ).spec;
  const view = new vega.View(vega.parse(spec, undefined, { ast: true }), {
    expr: expressionInterpreter,
    renderer: 'svg',
    container: host,
    hover: true,
    loader,
    logger,
  });
  try {
    await view.runAsync();
    let previousWidth = host.clientWidth;
    const observer = new ResizeObserver(() => {
      if (host.clientWidth === previousWidth || host.clientWidth < 1) return;
      previousWidth = host.clientWidth;
      void view.resize().runAsync().catch(onError);
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
      view.finalize();
      host.replaceChildren();
    };
  } catch (error) {
    view.finalize();
    throw error;
  }
}
