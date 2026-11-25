import { once } from 'node:events';
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  modelNetworkProbeOrigin,
  probeModelNetwork,
} from '#modules/system/model-availability-probe';

const servers: ReturnType<typeof createServer>[] = [];

async function serve(handler: RequestListener): Promise<string> {
  const server = createServer(handler).listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

describe('upstream network probe', () => {
  it('uses only the origin of a configured provider URL', () => {
    expect(
      modelNetworkProbeOrigin({
        pi_api: 'openai-completions',
        base_url:
          'https://user:password@opencode.ai:8443/inference/go/openai/v1?key=secret#route',
      }),
    ).toBe('https://opencode.ai:8443');
    expect(
      modelNetworkProbeOrigin({
        pi_api: 'openai-completions',
        base_url: 'ftp://example.invalid',
      }),
    ).toBeNull();
    expect(
      modelNetworkProbeOrigin({
        pi_api: 'openai-completions',
        base_url: 'not a url',
      }),
    ).toBeNull();
  });

  it.each([
    ['openai-completions', 'https://api.openai.com'],
    ['openai-responses', 'https://api.openai.com'],
    ['anthropic-messages', 'https://api.anthropic.com'],
    ['google-generative-ai', 'https://generativelanguage.googleapis.com'],
  ] as const)('uses the default origin for %s', (pi_api, origin) => {
    expect(modelNetworkProbeOrigin({ pi_api, base_url: null })).toBe(origin);
  });

  it.each([200, 400, 401, 404, 405, 429, 503])(
    'measures HEAD latency from HTTP %s without credentials or a session',
    async (status) => {
      const requests: Array<{
        method: string | undefined;
        path: string | undefined;
        auth: string | undefined;
        session: string | string[] | undefined;
      }> = [];
      const origin = await serve((request, response) => {
        requests.push({
          method: request.method,
          path: request.url,
          auth: request.headers.authorization,
          session: request.headers['x-opencode-session'],
        });
        response.writeHead(status);
        response.end();
      });

      expect(
        await probeModelNetwork(origin, new AbortController().signal),
      ).toBeGreaterThanOrEqual(0);
      expect(requests).toEqual([
        { method: 'HEAD', path: '/', auth: undefined, session: undefined },
      ]);
    },
  );

  it('measures a redirect without following it', async () => {
    const paths: string[] = [];
    const origin = await serve((request, response) => {
      paths.push(request.url!);
      if (request.url === '/')
        response.writeHead(302, { location: '/elsewhere' });
      response.end();
    });
    expect(
      await probeModelNetwork(origin, new AbortController().signal),
    ).toBeGreaterThanOrEqual(0);
    expect(paths).toEqual(['/']);
  });

  it('returns no latency when the server drops the connection or times out', async () => {
    const reset = await serve((request) => request.socket.destroy());
    const silent = await serve(() => {});
    const { signal } = new AbortController();
    expect(await probeModelNetwork(reset, signal)).toBeNull();
    expect(await probeModelNetwork(silent, signal, 100)).toBeNull();
  });

  it('cancels the request when the worker stops', async () => {
    const requestStarted = Promise.withResolvers<void>();
    const origin = await serve(() => requestStarted.resolve());
    const controller = new AbortController();
    const pending = probeModelNetwork(origin, controller.signal);
    await requestStarted.promise;
    controller.abort();
    expect(await pending).toBeNull();
    expect(await probeModelNetwork(origin, controller.signal)).toBeNull();
  });
});
