import { parentPort, workerData } from 'node:worker_threads';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('');
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
});
try {
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    maxTextSize: 16_000,
    maxEdges: 200,
    suppressErrorRendering: true,
  });
  const result = await mermaid.parse(workerData as string, {
    suppressErrors: true,
  });
  parentPort?.postMessage(result !== false);
} finally {
  dom.window.close();
}
