import { afterEach, describe, expect, it, vi } from 'vitest';

const originalAllowedOrigins = process.env.ALLOWED_ORIGINS;

afterEach(() => {
  if (originalAllowedOrigins === undefined) {
    delete process.env.ALLOWED_ORIGINS;
  } else {
    process.env.ALLOWED_ORIGINS = originalAllowedOrigins;
  }
  vi.resetModules();
});

describe('infrastructure config', () => {
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
