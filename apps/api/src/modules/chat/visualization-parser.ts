import { Worker } from 'node:worker_threads';

/** Mermaid needs a DOM even for parsing; keep it out of the API's global state and credentials. */
export function validateMermaid(spec: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const source = import.meta.url.endsWith('.ts')
      ? './visualization-parser-worker.ts'
      : './visualization-parser-worker.js';
    const worker = new Worker(new URL(source, import.meta.url), {
      workerData: spec,
      env: {},
      execArgv: [],
      resourceLimits: {
        maxOldGenerationSizeMb: 128,
        maxYoungGenerationSizeMb: 16,
        stackSizeMb: 4,
      },
    });
    let settled = false;
    const finish = (result: boolean | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const timer = setTimeout(
      () => finish(new Error('Diagram validation timed out')),
      4_000,
    );
    worker.once('message', (result) => finish(result === true));
    worker.once('error', (error) => finish(error));
    worker.once('exit', () =>
      finish(new Error('Diagram validator exited without a result')),
    );
  });
}
