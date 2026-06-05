import type { FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = {
  NODE_ENV: process.env.NODE_ENV,
  PAYMENT_CALLBACK_ALLOWED_HOSTS: process.env.PAYMENT_CALLBACK_ALLOWED_HOSTS,
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function requestWithHeaders(
  headers: FastifyRequest['headers'],
): FastifyRequest {
  return {
    headers,
    protocol: 'https',
  } as FastifyRequest;
}

async function loadResolver(env: {
  allowedHosts?: string;
  publicBaseUrl?: string;
}) {
  vi.resetModules();
  restoreEnv();
  process.env.NODE_ENV = 'production';
  if (env.allowedHosts !== undefined) {
    process.env.PAYMENT_CALLBACK_ALLOWED_HOSTS = env.allowedHosts;
  }
  if (env.publicBaseUrl !== undefined) {
    process.env.PUBLIC_BASE_URL = env.publicBaseUrl;
  }
  return import('./payment-callback-urls.js');
}

afterEach(() => {
  vi.resetModules();
  restoreEnv();
});

describe('resolvePaymentCallbackUrls', () => {
  it('prefers PUBLIC_BASE_URL over request Host headers', async () => {
    const { resolvePaymentCallbackUrls } = await loadResolver({
      publicBaseUrl: 'https://app.example.test/root',
    });

    const urls = resolvePaymentCallbackUrls(
      requestWithHeaders({
        host: 'app.example.test',
        'x-forwarded-host': 'attacker.example.test',
      }),
    );

    expect(urls).toEqual({
      notifyUrl: 'https://app.example.test/api/billing/recharge/notify',
      returnUrl: 'https://app.example.test/wallet',
    });
  });

  it('refuses untrusted forwarded hosts instead of building attacker callbacks', async () => {
    const { resolvePaymentCallbackUrls } = await loadResolver({});

    const urls = resolvePaymentCallbackUrls(
      requestWithHeaders({
        host: 'app.example.test',
        'x-forwarded-host': 'attacker.example.test',
        'x-forwarded-proto': 'https',
      }),
    );

    expect(urls).toEqual({
      notifyUrl: '/api/billing/recharge/notify',
      returnUrl: '/wallet',
    });
  });

  it('uses explicitly allowed hosts as the fallback origin', async () => {
    const { resolvePaymentCallbackUrls } = await loadResolver({
      allowedHosts: 'app.example.test',
    });

    const urls = resolvePaymentCallbackUrls(
      requestWithHeaders({
        host: 'app.example.test',
        'x-forwarded-proto': 'https',
      }),
    );

    expect(urls.notifyUrl).toBe(
      'https://app.example.test/api/billing/recharge/notify',
    );
    expect(urls.returnUrl).toBe('https://app.example.test/wallet');
  });

  it('rejects suspicious Host header syntax even when the hostname is allowed', async () => {
    const { resolvePaymentCallbackUrls } = await loadResolver({
      allowedHosts: 'app.example.test',
    });

    const urls = resolvePaymentCallbackUrls(
      requestWithHeaders({
        host: 'app.example.test/path',
      }),
    );

    expect(urls).toEqual({
      notifyUrl: '/api/billing/recharge/notify',
      returnUrl: '/wallet',
    });
  });
});
