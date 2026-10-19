import { afterEach, describe, expect, it, vi } from 'vitest';

const originalAllowedOrigins = process.env.ALLOWED_ORIGINS;
const originalTrustProxy = process.env.TRUST_PROXY;

afterEach(() => {
  if (originalAllowedOrigins === undefined) {
    delete process.env.ALLOWED_ORIGINS;
  } else {
    process.env.ALLOWED_ORIGINS = originalAllowedOrigins;
  }
  if (originalTrustProxy === undefined) {
    delete process.env.TRUST_PROXY;
  } else {
    process.env.TRUST_PROXY = originalTrustProxy;
  }
  vi.resetModules();
});

describe('infrastructure config', () => {
  it.each(['', '1', '2'])(
    'uses the loopback default for unset or legacy hop-count proxy trust (%s)',
    async (value) => {
      process.env.TRUST_PROXY = value;
      vi.resetModules();

      const config = await import('#infrastructure/config');
      expect(config.TRUST_PROXY).toBe('loopback');
    },
  );

  it.each(['false', '0'])(
    'preserves explicitly disabled proxy trust (%s)',
    async (value) => {
      process.env.TRUST_PROXY = value;
      vi.resetModules();

      const config = await import('#infrastructure/config');
      expect(config.TRUST_PROXY).toBe(false);
    },
  );

  it('preserves explicit proxy IP and CIDR allowlists', async () => {
    process.env.TRUST_PROXY = '127.0.0.1,192.0.2.0/24';
    vi.resetModules();

    const config = await import('#infrastructure/config');
    expect(config.TRUST_PROXY).toBe('127.0.0.1,192.0.2.0/24');
  });

  it('does not expose model provider defaults from environment config', async () => {
    vi.resetModules();
    const config = await import('#infrastructure/config');

    expect(config).not.toHaveProperty('AGENT_MODEL');
  });

  it('normalizes CORS allowed origins from environment config', async () => {
    process.env.ALLOWED_ORIGINS =
      'https://www.letfate.com, https://admin.letfate.com/path, invalid';
    vi.resetModules();

    const config = await import('#infrastructure/config');

    expect(config.ALLOWED_ORIGINS).toEqual([
      'https://www.letfate.com',
      'https://admin.letfate.com',
    ]);
  });
});
