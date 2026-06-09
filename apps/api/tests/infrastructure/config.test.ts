import { describe, expect, it } from 'vitest';

describe('infrastructure config', () => {
  it('does not expose model provider defaults from environment config', async () => {
    const config = await import('../../src/infrastructure/config.js');

    expect(config).not.toHaveProperty('AGENT_MODEL');
  });
});
